import * as vscode from 'vscode';
import { initLogger, logger } from './util/logger';
import { registerCommands } from './ui/commands';
import { PerfLensStatusBar } from './ui/statusBar';
import { SidecarClient } from './sidecar/client';
import { SidecarLifecycle } from './sidecar/lifecycle';
import { detectBuildSystem } from './build/detect';
import { loadProjectConfig } from './config/projectConfig';
import type { PingResult } from './sidecar/protocol';
import { RemarksDiagnosticProvider } from './diagnostics/provider';
import { RemarksHoverProvider } from './diagnostics/hover';
import { RemarksTreeDataProvider } from './panels/remarksPanel';
import { OptRecordsWatcher } from './build/watcher';

let _lifecycle: SidecarLifecycle | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Perf Lens');
  ctx.subscriptions.push(channel);
  initLogger(channel, 'info');

  logger.info('Perf Lens activating…');

  registerCommands(ctx);
  const statusBar = new PerfLensStatusBar(ctx);
  ctx.subscriptions.push(statusBar);

  void _initialiseAsync(ctx, statusBar);
}

async function _initialiseAsync(
  ctx: vscode.ExtensionContext,
  statusBar: PerfLensStatusBar,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    logger.warn('No workspace folder — Perf Lens inactive.');
    statusBar.setError('no workspace');
    return;
  }

  const config = loadProjectConfig(workspaceRoot);
  logger.info(`Project: ${config?.project?.name ?? '(unnamed)'}`);

  await detectBuildSystem(workspaceRoot);

  _lifecycle = new SidecarLifecycle(ctx, workspaceRoot);
  ctx.subscriptions.push(_lifecycle);

  let client: SidecarClient | undefined;
  try {
    client = await _lifecycle.start();
    const pong = await client.request<PingResult>('ping');
    logger.info(`Sidecar ping OK — pong=${String(pong.pong)}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`Sidecar unavailable: ${msg}`);
    statusBar.setNoSidecar();
    return;
  }
  if (!client) return;
  const sidecar = client; // const so closures below see SidecarClient, not SidecarClient|undefined

  // Phase 2: compiler remarks providers
  const diagnostics = new RemarksDiagnosticProvider(sidecar);
  ctx.subscriptions.push(diagnostics);

  const hoverProvider = new RemarksHoverProvider(sidecar);
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      hoverProvider,
    ),
  );

  const treeProvider = new RemarksTreeDataProvider(sidecar);
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('perfLens.remarks', treeProvider),
    treeProvider,
  );

  const watcher = new OptRecordsWatcher(sidecar, diagnostics, treeProvider);
  ctx.subscriptions.push(watcher);

  // Wire up the regenerate command now that we have a client
  ctx.subscriptions.push(
    vscode.commands.registerCommand('perfLens.regenerateRemarks', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a C/C++ file first.');
        return;
      }
      const file = editor.document.uri.fsPath;
      statusBar.setStarting();
      try {
        const result = await sidecar.request<{ remarksFile: string; count: number }>(
          'recompileWithRemarks', { file },
        );
        logger.info(`Remarks regenerated: ${result.count} remarks from ${result.remarksFile}`);
        await diagnostics.refreshFile(editor.document.uri);
        treeProvider.refresh();
        statusBar.setReady(result.count);
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`Regenerate failed: ${msg}`);
        void vscode.window.showErrorMessage(`Perf Lens: ${msg}`);
        statusBar.setReady();
      }
    }),
  );

  // Seed diagnostics for the currently open file
  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    if (doc.languageId === 'cpp' || doc.languageId === 'c') {
      void diagnostics.refreshFile(doc.uri);
    }
  }

  statusBar.setReady();
  logger.info('Perf Lens ready (Phase 2).');
}

export function deactivate(): void {
  _lifecycle?.dispose();
}

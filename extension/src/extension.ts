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
import { FindingsDiagnosticProvider } from './diagnostics/findingsProvider';
import { RemarksTreeDataProvider } from './panels/remarksPanel';
import { OptRecordsWatcher } from './build/watcher';
import { LLMManager, readSnippet } from './llm/manager';
import { ExplanationPanel } from './panels/explanationPanel';
import type { ProviderConfig } from './llm/types';
import type { OptRemark, Finding } from './sidecar/protocol';

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
  const sidecar = client;

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

  // Phase 3: static analysis findings
  const findingsProvider = new FindingsDiagnosticProvider(sidecar);
  ctx.subscriptions.push(findingsProvider);

  // Phase 4: LLM layer
  const llm = new LLMManager(ctx.globalStorageUri);
  ctx.subscriptions.push(llm);
  _initLLMProviders(llm);

  // Probe provider health asynchronously — don't block activation.
  if (llm.hasProviders) void llm.probeAll();

  // Commands
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

    vscode.commands.registerCommand('perfLens.translateRemark', async (remark: OptRemark) => {
      if (!llm.hasProviders) {
        void vscode.window.showInformationMessage(
          'Perf Lens: configure an LLM provider in settings to use AI translation.',
        );
        return;
      }
      const panel = ExplanationPanel.show(ctx, `Translate: ${remark.pass}/${remark.name}`);
      const ctrl  = new AbortController();
      const snippet = readSnippet(remark.file, remark.line);
      const result  = await llm.translateRemark(remark, snippet, ctrl.signal);
      if (result.type === 'silent_degrade') {
        panel.showDegrade(result.reason ?? 'No provider available.');
      } else if (result.stream) {
        await panel.streamResult(result.stream, ctrl.signal);
      }
    }),

    vscode.commands.registerCommand('perfLens.explainFinding', async (finding: Finding) => {
      if (!llm.hasProviders) {
        void vscode.window.showInformationMessage(
          'Perf Lens: configure an LLM provider in settings to use AI explanations.',
        );
        return;
      }
      const panel = ExplanationPanel.show(ctx, `Explain: ${finding.title}`);
      const ctrl  = new AbortController();
      const snippet = readSnippet(finding.file, finding.line);
      const result  = await llm.explainFinding(finding, snippet, ctrl.signal);
      if (result.type === 'silent_degrade') {
        panel.showDegrade(result.reason ?? 'No provider available.');
      } else if (result.stream) {
        await panel.streamResult(result.stream, ctrl.signal);
      }
    }),

    vscode.commands.registerCommand('perfLens.clearLLMCache', () => {
      llm.clearCache();
      void vscode.window.showInformationMessage('Perf Lens: LLM cache cleared.');
    }),
  );

  // Seed diagnostics for the currently open file
  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    if (doc.languageId === 'cpp' || doc.languageId === 'c') {
      void diagnostics.refreshFile(doc.uri);
      void findingsProvider.refreshFile(doc.uri);
    }
  }

  statusBar.setReady();
  logger.info('Perf Lens ready (Phase 4).');
}

function _initLLMProviders(llm: LLMManager): void {
  const cfg = vscode.workspace.getConfiguration('perfLens');

  // Auto-detect Ollama if perfLens.llm.primary starts with 'ollama:'
  const primary = cfg.get<string>('llm.primary', '');
  if (primary.startsWith('ollama:')) {
    const model = primary.slice('ollama:'.length);
    llm.addProvider({ id: 'ollama-primary', type: 'ollama', model });
  }

  // Explicit providers list from settings.
  const providers = cfg.get<ProviderConfig[]>('llm.providers', []);
  for (const p of providers) llm.addProvider(p);

  // Always try to auto-detect Ollama as fallback if no providers yet.
  if (!llm.hasProviders) {
    llm.addProvider({
      id: 'ollama-auto',
      type: 'ollama',
      model: 'qwen2.5-coder:7b',
    });
  }
}

export function deactivate(): void {
  _lifecycle?.dispose();
}

import * as vscode from 'vscode';
import { initLogger, logger } from './util/logger';
import { registerCommands } from './ui/commands';
import { PerfLensStatusBar } from './ui/statusBar';
import { SidecarLifecycle } from './sidecar/lifecycle';
import { detectBuildSystem } from './build/detect';
import { loadProjectConfig } from './config/projectConfig';
import type { PingResult } from './sidecar/protocol';

let _lifecycle: SidecarLifecycle | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Perf Lens');
  ctx.subscriptions.push(channel);
  initLogger(channel, 'info');

  logger.info('Perf Lens activating…');

  // Synchronous, cheap — must not block activation
  registerCommands(ctx);
  const statusBar = new PerfLensStatusBar(ctx);
  ctx.subscriptions.push(statusBar);

  // Async, non-blocking — errors are surfaced via status bar & output channel
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

  try {
    const client = await _lifecycle.start();
    const pong = await client.request<PingResult>('ping');
    logger.info(`Sidecar ping OK — pong=${String(pong.pong)}`);
    statusBar.setReady();
    logger.info('Perf Lens ready.');
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`Sidecar unavailable: ${msg}`);
    statusBar.setNoSidecar();
  }
}

export function deactivate(): void {
  _lifecycle?.dispose();
}

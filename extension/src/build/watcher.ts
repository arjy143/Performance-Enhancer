import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import { type RemarksDiagnosticProvider } from '../diagnostics/provider';
import { type RemarksTreeDataProvider } from '../panels/remarksPanel';
import { logger } from '../util/logger';

export class OptRecordsWatcher implements vscode.Disposable {
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _subs: vscode.Disposable[] = [];

  // Fires with the source file path after remarks for it are ingested.
  private readonly _onRemarksIngested = new vscode.EventEmitter<string>();
  readonly onRemarksIngested = this._onRemarksIngested.event;

  constructor(
    private readonly _client: SidecarClient,
    private readonly _diagnostics: RemarksDiagnosticProvider,
    private readonly _panel: RemarksTreeDataProvider,
  ) {
    this._watcher = vscode.workspace.createFileSystemWatcher('**/*.opt.yaml');

    this._subs.push(
      this._watcher.onDidCreate(uri => void this._ingest(uri)),
      this._watcher.onDidChange(uri => void this._ingest(uri)),
      this._watcher.onDidDelete(_uri => {
        this._diagnostics.clearAll();
        this._panel.refresh();
      }),
    );
  }

  private async _ingest(uri: vscode.Uri): Promise<void> {
    const path = uri.fsPath;
    logger.info('watcher: ingesting', path);
    try {
      await this._client.request('ingestRemarksFile', { path });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.warn('watcher: ingestRemarksFile failed for', path, msg);
      void vscode.window.showWarningMessage(
        `Perf Lens: failed to ingest compiler remarks from ${path.split('/').pop()} : ${msg}`,
      );
      return;
    }
    this._panel.refresh();

    // Re-push diagnostics for the active editor if it's a C/C++ file
    const active = vscode.window.activeTextEditor;
    if (active && (active.document.languageId === 'cpp' || active.document.languageId === 'c')) {
      void this._diagnostics.refreshFile(active.document.uri);
      this._onRemarksIngested.fire(active.document.uri.fsPath);
    }
  }

  dispose(): void {
    this._watcher.dispose();
    this._subs.forEach(s => s.dispose());
    this._onRemarksIngested.dispose();
  }
}

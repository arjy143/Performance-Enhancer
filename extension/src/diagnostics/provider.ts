import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import { type OptRemark, RemarkType } from '../sidecar/protocol';
import { logger } from '../util/logger';

const SOURCE = 'perf-lens';

function remarkSeverity(r: OptRemark): vscode.DiagnosticSeverity {
  switch (r.type) {
    case RemarkType.Missed:   return vscode.DiagnosticSeverity.Warning;
    case RemarkType.Analysis: return vscode.DiagnosticSeverity.Information;
    default:                  return vscode.DiagnosticSeverity.Hint;
  }
}

export class RemarksDiagnosticProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _subs: vscode.Disposable[] = [];

  constructor(private readonly _client: SidecarClient) {
    this._collection = vscode.languages.createDiagnosticCollection(SOURCE);
    this._subs.push(
      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e?.document.languageId === 'cpp' || e?.document.languageId === 'c') {
          void this.refreshFile(e.document.uri);
        }
      }),
    );
  }

  async refreshFile(uri: vscode.Uri): Promise<void> {
    const file = uri.fsPath;
    let remarks: OptRemark[];
    try {
      remarks = await this._client.request<OptRemark[]>('getRemarks', { file });
    } catch (err) {
      logger.warn('diagnostics: getRemarks failed for', file, err);
      return;
    }

    const diags: vscode.Diagnostic[] = remarks.map(r => {
      const line = Math.max(0, r.line - 1);
      const range = new vscode.Range(line, r.column, line, r.column + 1);
      const diag = new vscode.Diagnostic(range, r.message, remarkSeverity(r));
      diag.source = SOURCE;
      diag.code = r.name;
      if (r.isStale) {
        diag.tags = [vscode.DiagnosticTag.Deprecated];
      }
      return diag;
    });

    this._collection.set(uri, diags);
    logger.debug('diagnostics: set', diags.length, 'for', file);
  }

  clearFile(uri: vscode.Uri): void {
    this._collection.delete(uri);
  }

  clearAll(): void {
    this._collection.clear();
  }

  dispose(): void {
    this._collection.dispose();
    this._subs.forEach(s => s.dispose());
  }
}

import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import {
  type Finding,
  ConfidenceLevel,
  FINDING_CATEGORY_LABELS,
  CONFIDENCE_LABELS,
} from '../sidecar/protocol';
import { logger } from '../util/logger';

const SOURCE = 'perf-lens-static';

function findingSeverity(f: Finding): vscode.DiagnosticSeverity {
  switch (f.confidence) {
    case ConfidenceLevel.High:   return vscode.DiagnosticSeverity.Warning;
    case ConfidenceLevel.Medium: return vscode.DiagnosticSeverity.Information;
    default:                     return vscode.DiagnosticSeverity.Hint;
  }
}

function findingToMarkdown(f: Finding): vscode.MarkdownString {
  const cat  = FINDING_CATEGORY_LABELS[f.category] ?? 'Other';
  const conf = CONFIDENCE_LABELS[f.confidence] ?? 'unknown';
  const md = new vscode.MarkdownString(
    `**$(lightbulb) ${f.title}**\n\n${f.message}\n\n` +
    `| | |\n|---|---|\n` +
    `| Category | ${cat} |\n` +
    `| Confidence | ${conf} |\n` +
    `| Rule | \`${f.ruleId}\` |`,
    true,
  );
  md.isTrusted = true;
  return md;
}

export class FindingsDiagnosticProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _subs: vscode.Disposable[] = [];

  constructor(private readonly _client: SidecarClient) {
    this._collection = vscode.languages.createDiagnosticCollection(SOURCE);
    this._subs.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'cpp' || doc.languageId === 'c') {
          void this.analyseAndRefresh(doc.uri);
        }
      }),
    );
  }

  async analyseAndRefresh(uri: vscode.Uri): Promise<void> {
    const file = uri.fsPath;
    try {
      await this._client.request<{ count: number }>('analyseFile', { file });
    } catch (err) {
      logger.warn('findings: analyseFile failed for', file, err);
      return;
    }
    await this.refreshFile(uri);
  }

  async refreshFile(uri: vscode.Uri): Promise<void> {
    const file = uri.fsPath;
    let findings: Finding[];
    try {
      findings = await this._client.request<Finding[]>('getFindings', { file });
    } catch (err) {
      logger.warn('findings: getFindings failed for', file, err);
      return;
    }

    const diags: vscode.Diagnostic[] = findings.map(f => {
      const line  = Math.max(0, f.line - 1);
      const range = new vscode.Range(line, f.column, line, f.column + 1);
      const diag  = new vscode.Diagnostic(range, f.message, findingSeverity(f));
      diag.source  = SOURCE;
      diag.code    = f.ruleId;
      return diag;
    });

    this._collection.set(uri, diags);
    logger.debug('findings: set', diags.length, 'for', file);
  }

  clearFile(uri: vscode.Uri): void {
    this._collection.delete(uri);
  }

  dispose(): void {
    this._collection.dispose();
    this._subs.forEach(s => s.dispose());
  }
}

export { findingToMarkdown };

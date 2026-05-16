import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import {
  type Finding,
  ConfidenceLevel,
  FindingCategory,
  FINDING_CATEGORY_LABELS,
  CONFIDENCE_LABELS,
} from '../sidecar/protocol';
import { type ProfileManager } from '../profile/profileManager';
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
  const args = encodeURIComponent(JSON.stringify(f));
  const extraLinks: string[] = [
    `[$(sparkle) Explain with AI](command:perfLens.explainFinding?${args})`,
    `[$(wrench) Open Loop Analyser](command:perfLens.openLoopAnalyser?${args})`,
  ];
  if (f.category === FindingCategory.MemoryLayout) {
    extraLinks.push(`[$(layout) Cache-Line Layout](command:perfLens.showCacheLineLayout?${args})`);
  }
  const md = new vscode.MarkdownString(
    `**$(lightbulb) ${f.title}**\n\n${f.message}\n\n` +
    `| | |\n|---|---|\n` +
    `| Category | ${cat} |\n` +
    `| Confidence | ${conf} |\n` +
    `| Rule | \`${f.ruleId}\` |\n\n` +
    extraLinks.join(' · '),
    true,
  );
  md.isTrusted = true;
  return md;
}

export class FindingsDiagnosticProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _subs: vscode.Disposable[] = [];
  private _profileManager: ProfileManager | undefined;

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

  setProfileManager(pm: ProfileManager): void {
    this._profileManager = pm;
    // Re-decorate when profile changes
    this._subs.push(
      pm.onProfileChanged(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) void this.refreshFile(editor.document.uri);
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

    // Optionally annotate with hotness from active profile
    let hotnessMap = new Map<number, number>();  // line → fraction
    if (this._profileManager?.hasActiveProfile) {
      const rows = await this._profileManager.getFileHotness(file).catch(() => []);
      for (const h of rows) hotnessMap.set(h.line, h.fraction);
    }

    const diags: vscode.Diagnostic[] = findings.map(f => {
      const line  = Math.max(0, f.line - 1);
      const range = new vscode.Range(line, f.column, line, f.column + 1);
      const hot   = hotnessMap.get(f.line);

      // Upgrade severity for hot findings; downgrade for cold ones
      let severity = findingSeverity(f);
      if (hot !== undefined) {
        if (hot >= 0.05) severity = vscode.DiagnosticSeverity.Warning;   // always warn if hot
        else if (hot < 0.005) severity = vscode.DiagnosticSeverity.Hint; // demote if cold
      }

      const hotLabel = hot !== undefined ? ` [${(hot * 100).toFixed(1)}% cycles]` : '';
      const diag  = new vscode.Diagnostic(range, f.message + hotLabel, severity);
      diag.source  = SOURCE;
      diag.code    = f.ruleId;
      return diag;
    });

    // Sort: hot findings first (those with hotness annotation, descending)
    diags.sort((a, b) => {
      const hotA = hotnessMap.get((a.range.start.line + 1)) ?? -1;
      const hotB = hotnessMap.get((b.range.start.line + 1)) ?? -1;
      return hotB - hotA;
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

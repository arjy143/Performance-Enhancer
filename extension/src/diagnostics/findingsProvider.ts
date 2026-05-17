import * as vscode from 'vscode';
import * as fs from 'fs';
import { type SidecarClient } from '../sidecar/client';
import {
  type Finding,
  ConfidenceLevel,
  FindingCategory,
  FINDING_CATEGORY_LABELS,
  CONFIDENCE_LABELS,
} from '../sidecar/protocol';
import { type ProfileManager } from '../profile/profileManager';
import { loadProjectConfig, type ProjectConfig } from '../config/projectConfig';
import { logger } from '../util/logger';

const SOURCE = 'perf-lens-static';

// Inline suppression marker scanned in source files.
const INLINE_SUPPRESS_RE = /\/\/\s*perf-lens:\s*suppress\s+([\w.\-]+)/;

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

// ---------------------------------------------------------------------------
// Suppression helpers
// ---------------------------------------------------------------------------

interface SuppressionSet {
  // file-glob → set of suppressed rule IDs ('*' means all rules)
  fileRules: Map<string, Set<string>>;
  // globally disabled rule IDs (from rules.disabled)
  globalDisabled: Set<string>;
}

function buildSuppressions(config: ProjectConfig | undefined): SuppressionSet {
  const fileRules = new Map<string, Set<string>>();
  const globalDisabled = new Set(config?.rules?.disabled ?? []);

  for (const s of config?.suppressions ?? []) {
    if (!s.file) continue;
    const rules = new Set(s.rules ?? ['*']);
    fileRules.set(s.file, rules);
  }
  return { fileRules, globalDisabled };
}

function isGlobMatch(pattern: string, filePath: string): boolean {
  // Simple glob: support '*' and '**' via regex conversion.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLE§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLE§/g, '.*');
  return new RegExp(`(^|/)${escaped}$`).test(filePath);
}

function isSuppressed(supp: SuppressionSet, finding: Finding): boolean {
  if (supp.globalDisabled.has(finding.ruleId)) return true;

  for (const [pattern, rules] of supp.fileRules) {
    if (isGlobMatch(pattern, finding.file)) {
      if (rules.has('*') || rules.has(finding.ruleId)) return true;
    }
  }
  return false;
}

// Read suppressed rule IDs declared inline on the same line as the finding.
// A comment `// perf-lens: suppress perf-lens.stl.endl-in-hot` on the finding
// line suppresses that specific rule.
function inlineSuppressedRules(filePath: string): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>();
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return result;
  }
  lines.forEach((line, idx) => {
    const m = INLINE_SUPPRESS_RE.exec(line);
    if (m) {
      const lineNo = idx + 1; // 1-based
      if (!result.has(lineNo)) result.set(lineNo, new Set());
      result.get(lineNo)!.add(m[1]);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Findings diagnostic provider
// ---------------------------------------------------------------------------

export class FindingsDiagnosticProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _subs: vscode.Disposable[] = [];
  private _profileManager: ProfileManager | undefined;
  private _suppressions: SuppressionSet = { fileRules: new Map(), globalDisabled: new Set() };

  // Cache of findings per file — used by the hover provider.
  private readonly _findingsCache = new Map<string, Finding[]>();

  constructor(
    private readonly _client: SidecarClient,
    workspaceRoot?: string,
  ) {
    this._collection = vscode.languages.createDiagnosticCollection(SOURCE);

    // Load suppressions from .perf-lens.yaml if a workspace root is given.
    if (workspaceRoot) {
      const config = loadProjectConfig(workspaceRoot);
      this._suppressions = buildSuppressions(config);
    }

    this._subs.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'cpp' || doc.languageId === 'c') {
          const cfg = vscode.workspace.getConfiguration('perfLens');
          if (cfg.get<boolean>('analyseOnSave', true)) {
            void this.analyseAndRefresh(doc.uri);
          }
        }
      }),
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (
          doc.uri.scheme === 'file' &&
          (doc.languageId === 'cpp' || doc.languageId === 'c')
        ) {
          const cfg = vscode.workspace.getConfiguration('perfLens');
          if (cfg.get<boolean>('analyseOnOpen', true)) {
            void this.analyseAndRefresh(doc.uri);
          }
        }
      }),
    );
  }

  setProfileManager(pm: ProfileManager): void {
    this._profileManager = pm;
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

    // Apply .perf-lens.yaml suppressions.
    const inlineSupp = inlineSuppressedRules(file);
    findings = findings.filter(f => {
      if (isSuppressed(this._suppressions, f)) return false;
      const lineSupp = inlineSupp.get(f.line);
      if (lineSupp && (lineSupp.has('*') || lineSupp.has(f.ruleId))) return false;
      return true;
    });

    // Apply minConfidence VS Code setting.
    const minConf = vscode.workspace.getConfiguration('perfLens').get<string>('minConfidence', 'medium');
    const minConfLevel = minConf === 'high' ? ConfidenceLevel.High
                       : minConf === 'low'  ? ConfidenceLevel.Low
                       : ConfidenceLevel.Medium;
    findings = findings.filter(f => f.confidence >= minConfLevel);

    // Cache for hover provider.
    this._findingsCache.set(file, findings);

    // Optionally annotate with hotness from active profile.
    const hotnessMap = new Map<number, number>(); // line → fraction
    if (this._profileManager?.hasActiveProfile) {
      const rows = await this._profileManager.getFileHotness(file).catch(() => []);
      for (const h of rows) hotnessMap.set(h.line, h.fraction);
    }

    const maxFindings = vscode.workspace.getConfiguration('perfLens').get<number>('ui.maxFindingsPerFile', 50);
    const diags: vscode.Diagnostic[] = findings.slice(0, maxFindings).map(f => {
      const line  = Math.max(0, f.line - 1);
      const range = new vscode.Range(line, f.column, line, f.column + 1);
      const hot   = hotnessMap.get(f.line);

      let severity = findingSeverity(f);
      if (hot !== undefined) {
        if (hot >= 0.05) severity = vscode.DiagnosticSeverity.Warning;
        else if (hot < 0.005) severity = vscode.DiagnosticSeverity.Hint;
      }

      const hotLabel = hot !== undefined ? ` [${(hot * 100).toFixed(1)}% cycles]` : '';
      const diag  = new vscode.Diagnostic(range, f.message + hotLabel, severity);
      diag.source  = SOURCE;
      diag.code    = f.ruleId;
      return diag;
    });

    diags.sort((a, b) => {
      const hotA = hotnessMap.get((a.range.start.line + 1)) ?? -1;
      const hotB = hotnessMap.get((b.range.start.line + 1)) ?? -1;
      return hotB - hotA;
    });

    this._collection.set(uri, diags);
    logger.debug('findings: set', diags.length, 'for', file);
  }

  findingsAt(file: string, line: number): Finding[] {
    return (this._findingsCache.get(file) ?? []).filter(f => f.line === line);
  }

  clearFile(uri: vscode.Uri): void {
    this._collection.delete(uri);
    this._findingsCache.delete(uri.fsPath);
  }

  dispose(): void {
    this._collection.dispose();
    this._subs.forEach(s => s.dispose());
  }
}

// ---------------------------------------------------------------------------
// Findings hover provider — shows rich markdown with AI explain link
// ---------------------------------------------------------------------------

export class FindingsHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  constructor(private readonly _provider: FindingsDiagnosticProvider) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const findings = this._provider.findingsAt(document.uri.fsPath, position.line + 1);
    if (findings.length === 0) return undefined;

    const md = new vscode.MarkdownString(
      findings.map(f => findingToMarkdown(f).value).join('\n\n---\n\n'),
      true,
    );
    md.isTrusted = true;
    return new vscode.Hover(md, document.lineAt(position.line).range);
  }

  dispose(): void { /* nothing owned */ }
}

export { findingToMarkdown };

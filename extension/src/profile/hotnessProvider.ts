import * as vscode from 'vscode';
import { type ProfileManager } from './profileManager';
import { logger } from '../util/logger';

// Five intensity buckets: none / trace / warm / hot / critical
// Fraction thresholds: trace≥0.1% / warm≥1% / hot≥5% / critical≥15%
const BUCKETS = [
  { minFraction: 0.15, label: 'critical', color: new vscode.ThemeColor('perf-lens.hotness.critical') },
  { minFraction: 0.05, label: 'hot',      color: new vscode.ThemeColor('perf-lens.hotness.hot')      },
  { minFraction: 0.01, label: 'warm',     color: new vscode.ThemeColor('perf-lens.hotness.warm')     },
  { minFraction: 0.001, label: 'trace',   color: new vscode.ThemeColor('perf-lens.hotness.trace')   },
] as const;

function bucketFor(fraction: number): typeof BUCKETS[number] | null {
  for (const b of BUCKETS) {
    if (fraction >= b.minFraction) return b;
  }
  return null;
}

export class GutterHeatmapProvider implements vscode.Disposable {
  private _subs: vscode.Disposable[] = [];

  // One decoration type per bucket (created once, reused)
  private _decorations: Map<string, vscode.TextEditorDecorationType> = new Map();

  constructor(private readonly _profileManager: ProfileManager) {
    // Build decoration types
    for (const b of BUCKETS) {
      const dtype = vscode.window.createTextEditorDecorationType({
        gutterIconSize: 'contain',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        backgroundColor: b.color,     // subtle line tint
        overviewRulerColor: b.color,
        isWholeLine: false,
      });
      this._decorations.set(b.label, dtype);
    }

    this._subs.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) void this.updateEditor(editor);
      }),
      _profileManager.onProfileChanged(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) void this.updateEditor(editor);
      }),
    );

    // Apply to currently open editor
    if (vscode.window.activeTextEditor) {
      void this.updateEditor(vscode.window.activeTextEditor);
    }
  }

  async updateEditor(editor: vscode.TextEditor): Promise<void> {
    const langId = editor.document.languageId;
    if (langId !== 'cpp' && langId !== 'c') {
      this._clearDecorations(editor);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('perfLens');
    if (!cfg.get<boolean>('ui.showGutterHeatmap', true)) {
      this._clearDecorations(editor);
      return;
    }

    if (!this._profileManager.hasActiveProfile) {
      this._clearDecorations(editor);
      return;
    }

    const file   = editor.document.uri.fsPath;
    const rows   = await this._profileManager.getFileHotness(file);

    if (rows.length === 0) {
      this._clearDecorations(editor);
      return;
    }

    // Group ranges by bucket
    const bucketRanges = new Map<string, vscode.DecorationOptions[]>();
    for (const b of BUCKETS) bucketRanges.set(b.label, []);

    for (const row of rows) {
      const bucket = bucketFor(row.fraction);
      if (!bucket) continue;
      const vsLine = Math.max(0, row.line - 1);
      const range  = editor.document.lineAt(vsLine).range;
      const pct    = (row.fraction * 100).toFixed(1);
      bucketRanges.get(bucket.label)!.push({
        range,
        hoverMessage: new vscode.MarkdownString(
          `**Perf Lens Hotness** - ${pct}% of CPU cycles (${bucket.label})`,
        ),
      });
    }

    for (const b of BUCKETS) {
      const dtype = this._decorations.get(b.label);
      if (dtype) editor.setDecorations(dtype, bucketRanges.get(b.label) ?? []);
    }

    logger.debug(`hotnessProvider: decorated ${rows.length} lines in ${file}`);
  }

  private _clearDecorations(editor: vscode.TextEditor): void {
    for (const dtype of this._decorations.values()) {
      editor.setDecorations(dtype, []);
    }
  }

  dispose(): void {
    for (const dtype of this._decorations.values()) dtype.dispose();
    this._subs.forEach(s => s.dispose());
  }
}

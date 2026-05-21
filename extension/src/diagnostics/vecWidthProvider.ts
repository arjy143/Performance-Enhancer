import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import { RemarkType } from '../sidecar/protocol';
import type { OptRemark } from '../sidecar/protocol';
import { logger } from '../util/logger';

// Annotation shown after the loop line in the editor.
interface VecAnnotation {
  line: number;   // 1-based
  width: number;  // 0 = missed (no width extracted)
  missed: boolean;
  reason: string; // brief missed reason, or ''
}

// Parse vectorization width from a Clang loop-vectorize remark message.
// Message forms:
//   "vectorized loop (vectorization width: 8, interleaved count: 2)"
//   "loop not vectorized: unsafe dependent memory operations in loop"
function parseVecAnnotation(remark: OptRemark): VecAnnotation | null {
  if (remark.pass !== 'loop-vectorize') return null;

  const missed = remark.type === RemarkType.Missed;

  if (!missed && remark.type === RemarkType.Passed) {
    const m = remark.message.match(/vectorization width[:\s]*(\d+)/i);
    const width = m ? parseInt(m[1], 10) : 1;
    return { line: remark.line, width, missed: false, reason: '' };
  }

  if (missed) {
    // Extract the reason after the colon: "loop not vectorized: <reason>"
    const colonIdx = remark.message.indexOf(':');
    const reason = colonIdx >= 0
      ? remark.message.slice(colonIdx + 1).trim().replace(/\s+/g, ' ').slice(0, 60)
      : remark.message.slice(0, 60);
    return { line: remark.line, width: 0, missed: true, reason };
  }

  return null;
}

// Width → display label and colour.
function widthStyle(width: number): { label: string; color: string } {
  if (width >= 16) return { label: `${width}x`, color: '#c5a000' }; // AVX-512: gold
  if (width >= 8)  return { label: `${width}x`, color: '#4fa84f' }; // AVX2: green
  if (width >= 4)  return { label: `${width}x`, color: '#4a8ec4' }; // SSE/NEON: blue
  if (width >= 2)  return { label: `${width}x`, color: '#7fa8c4' }; // narrow: pale blue
  return { label: `${width}x`, color: '#888888' };                   // scalar
}

const MISSED_STYLE = { label: 'miss', color: '#c86040' };

export class VecWidthProvider implements vscode.Disposable {
  private readonly _subs: vscode.Disposable[] = [];
  private _enabled = true;

  // One decoration type per distinct label+colour. Keyed by label.
  private readonly _decTypes = new Map<string, vscode.TextEditorDecorationType>();

  // Decoration type for missed loops.
  private readonly _missedDecType: vscode.TextEditorDecorationType;

  constructor(private readonly _client: SidecarClient) {
    // Missed decoration type (fixed style, variable tooltip set per-instance).
    this._missedDecType = vscode.window.createTextEditorDecorationType({
      after: {
        color:       MISSED_STYLE.color,
        fontStyle:   'italic',
        margin:      '0 0 0 1.5em',
      },
    });

    this._subs.push(
      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e) void this._decorate(e);
        else   this._clearAll();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('perfLens.ui.showVecWidthHeatmap')) {
          this._enabled = vscode.workspace.getConfiguration('perfLens').get<boolean>('ui.showVecWidthHeatmap', true);
          const editor = vscode.window.activeTextEditor;
          if (editor) void this._decorate(editor);
        }
      }),
    );

    this._enabled = vscode.workspace.getConfiguration('perfLens').get<boolean>('ui.showVecWidthHeatmap', true);

    if (vscode.window.activeTextEditor) {
      void this._decorate(vscode.window.activeTextEditor);
    }
  }

  // Called by OptRecordsWatcher after a new ingest for a file.
  async onFileIngested(filePath: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.fsPath === filePath) {
      await this._decorate(editor);
    }
  }

  private async _decorate(editor: vscode.TextEditor): Promise<void> {
    const lang = editor.document.languageId;
    if (lang !== 'cpp' && lang !== 'c') {
      this._clearEditor(editor);
      return;
    }

    if (!this._enabled) {
      this._clearEditor(editor);
      return;
    }

    let remarks: OptRemark[];
    try {
      remarks = await this._client.request<OptRemark[]>(
        'getRemarks', { file: editor.document.uri.fsPath }, new AbortController().signal,
      );
    } catch (err) {
      logger.debug('vecWidth: getRemarks failed', err);
      return;
    }

    const annotations: VecAnnotation[] = [];
    for (const r of remarks) {
      const ann = parseVecAnnotation(r);
      if (ann) annotations.push(ann);
    }

    this._applyDecorations(editor, annotations);
  }

  private _applyDecorations(editor: vscode.TextEditor, annotations: VecAnnotation[]): void {
    // Group by label for vectorised, separately collect missed.
    const byLabel = new Map<string, vscode.DecorationOptions[]>();
    const missedOpts: vscode.DecorationOptions[] = [];

    for (const ann of annotations) {
      const lineIdx = ann.line - 1;
      if (lineIdx < 0 || lineIdx >= editor.document.lineCount) continue;

      const line    = editor.document.lineAt(lineIdx);
      const range   = new vscode.Range(lineIdx, line.range.end.character, lineIdx, line.range.end.character);

      if (ann.missed) {
        const tooltip = ann.reason ? `Loop not vectorised: ${ann.reason}` : 'Loop not vectorised';
        missedOpts.push({
          range,
          renderOptions: { after: { contentText: ` [miss]`, color: MISSED_STYLE.color } },
          hoverMessage: new vscode.MarkdownString(`**Perf Lens**: ${tooltip}`),
        });
      } else {
        const { label, color } = widthStyle(ann.width);
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label)!.push({
          range,
          renderOptions: { after: { contentText: ` [${label}]`, color } },
          hoverMessage: new vscode.MarkdownString(
            `**Perf Lens**: loop vectorised at width **${ann.width}x** (SIMD)`),
        });
      }
    }

    // Apply missed decorations.
    editor.setDecorations(this._missedDecType, missedOpts);

    // Collect all labels that appeared.
    const allLabels = new Set(byLabel.keys());

    // Apply (or clear) each label's decoration type.
    for (const [label, opts] of byLabel) {
      editor.setDecorations(this._getOrCreateDecType(label), opts);
    }

    // Clear dec types for labels that are no longer present.
    for (const [label, dtype] of this._decTypes) {
      if (!allLabels.has(label)) editor.setDecorations(dtype, []);
    }
  }

  private _getOrCreateDecType(label: string): vscode.TextEditorDecorationType {
    if (!this._decTypes.has(label)) {
      const dtype = vscode.window.createTextEditorDecorationType({
        after: { margin: '0 0 0 1.5em' },
      });
      this._decTypes.set(label, dtype);
      this._subs.push(dtype);
    }
    return this._decTypes.get(label)!;
  }

  private _clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this._missedDecType, []);
    for (const dtype of this._decTypes.values()) {
      editor.setDecorations(dtype, []);
    }
  }

  private _clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this._clearEditor(editor);
    }
  }

  dispose(): void {
    this._missedDecType.dispose();
    this._subs.forEach(s => s.dispose());
  }
}

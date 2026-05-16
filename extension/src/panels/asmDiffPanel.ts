import * as vscode from 'vscode';
import type { AsmDiff, CompileResult } from '../sidecar/protocol';

export class AsmDiffPanel implements vscode.Disposable {
  private static _current?: AsmDiffPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;

  private constructor(ctx: vscode.ExtensionContext) {
    this._panel = vscode.window.createWebviewPanel(
      'perfLensAsmDiff',
      'Perf Lens: Asm Diff',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.onDidDispose(() => {
      this._disposed = true;
      if (AsmDiffPanel._current === this) AsmDiffPanel._current = undefined;
    });
    ctx.subscriptions.push(this);
  }

  static show(ctx: vscode.ExtensionContext): AsmDiffPanel {
    if (AsmDiffPanel._current && !AsmDiffPanel._current._disposed) {
      AsmDiffPanel._current._panel.reveal(vscode.ViewColumn.Beside, true);
      return AsmDiffPanel._current;
    }
    const p = new AsmDiffPanel(ctx);
    AsmDiffPanel._current = p;
    return p;
  }

  render(
    title: string,
    before: CompileResult,
    after: CompileResult,
    diff: AsmDiff,
    verified: boolean,
  ): void {
    this._panel.title = `Asm Diff: ${title}`;
    this._panel.webview.html = this._html(title, before, after, diff, verified);
  }

  dispose(): void {
    if (!this._disposed) this._panel.dispose();
  }

  private _html(
    title: string,
    before: CompileResult,
    after: CompileResult,
    diff: AsmDiff,
    verified: boolean,
  ): string {
    const statusColour = verified ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)';
    const statusIcon   = verified ? '✓' : '✗';
    const statusText   = verified ? 'Verified' : 'Not verified';

    const beforeLines = (before.assembly.text || '(empty)').split('\n');
    const afterLines  = (after.assembly.text  || '(empty)').split('\n');

    const renderLines = (lines: string[]) =>
      lines.map(l => `<div class="asm-line">${escHtml(l)}</div>`).join('');

    const renderChanges = () => diff.changes.map(c => {
      let cls = 'unchanged';
      let text = '';
      if (c.kind === 'added')   { cls = 'added';   text = escHtml(c.afterText); }
      if (c.kind === 'removed') { cls = 'removed'; text = escHtml(c.beforeText); }
      if (c.kind === 'unchanged') { text = escHtml(c.beforeText || c.afterText); }
      const cat = c.category ? ` <span class="cat">${escHtml(c.category)}</span>` : '';
      return `<div class="diff-line ${cls}">${text}${cat}</div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px;
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         padding: 16px; margin: 0; }
  h2 { font-size: 1em; font-weight: 600; margin: 0 0 8px 0; }
  .status { color: ${statusColour}; font-weight: 600; margin-bottom: 12px; }
  .summary { margin-bottom: 16px; color: var(--vscode-descriptionForeground); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .col h3 { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin: 0 0 4px 0; }
  .asm-box { background: var(--vscode-textCodeBlock-background);
             border: 1px solid var(--vscode-panel-border); border-radius: 4px;
             padding: 8px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
  .asm-line { white-space: pre; line-height: 1.5; }
  .diff-box { background: var(--vscode-textCodeBlock-background);
              border: 1px solid var(--vscode-panel-border); border-radius: 4px;
              padding: 8px; overflow-x: auto; max-height: 400px; overflow-y: auto; margin-top: 16px; }
  .diff-line { white-space: pre; line-height: 1.5; }
  .added   { background: rgba(0,200,80,0.12); color: var(--vscode-gitDecoration-addedResourceForeground); }
  .removed { background: rgba(200,0,0,0.12);  color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .cat { font-size: 0.75em; opacity: 0.7; margin-left: 8px; font-style: italic; }
  .stats { display: flex; gap: 24px; margin-bottom: 8px; }
  .stat { text-align: center; }
  .stat .val { font-size: 1.2em; font-weight: 600; }
  .stat .lbl { font-size: 0.75em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h2>${escHtml(title)}</h2>
<div class="status">${statusIcon} ${statusText}</div>
<div class="summary">${escHtml(diff.summary)}</div>
<div class="stats">
  <div class="stat"><div class="val">${before.assembly.vectorWidthUsed}x → ${after.assembly.vectorWidthUsed}x</div><div class="lbl">Vector width</div></div>
  <div class="stat"><div class="val">${diff.instructionsBefore} → ${diff.instructionsAfter}</div><div class="lbl">Instructions</div></div>
  <div class="stat"><div class="val">${before.wallTimeMs}ms / ${after.wallTimeMs}ms</div><div class="lbl">Compile time</div></div>
</div>
<div class="cols">
  <div class="col"><h3>Before</h3><div class="asm-box">${renderLines(beforeLines)}</div></div>
  <div class="col"><h3>After</h3><div class="asm-box">${renderLines(afterLines)}</div></div>
</div>
<div class="diff-box">${renderChanges()}</div>
</body>
</html>`;
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

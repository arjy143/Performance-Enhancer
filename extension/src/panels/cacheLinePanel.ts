import * as vscode from 'vscode';
import type { Finding } from '../sidecar/protocol';

export interface StructField {
  name:    string;
  type:    string;
  offset:  number;
  size:    number;
  isPad:   boolean;
}

// Parse field info from the finding message.
// Message format from padding_detected.cpp:
//   "Struct '<name>' wastes N bytes of padding (sizeof=X, packed=Y)"
export function parsePaddingFinding(finding: Finding): {
  structName: string;
  wastedBytes: number;
  totalSize: number;
} | undefined {
  const m = finding.message.match(/Struct '(.+)' wastes (\d+) bytes.*sizeof=(\d+)/);
  if (!m) return undefined;
  return { structName: m[1], wastedBytes: parseInt(m[2]), totalSize: parseInt(m[3]) };
}

export class CacheLinePanel implements vscode.Disposable {
  private static _current?: CacheLinePanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;

  private constructor(ctx: vscode.ExtensionContext) {
    this._panel = vscode.window.createWebviewPanel(
      'perfLensCacheLine',
      'Perf Lens: Cache-Line Layout',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.onDidDispose(() => {
      this._disposed = true;
      if (CacheLinePanel._current === this) CacheLinePanel._current = undefined;
    });
    ctx.subscriptions.push(this);
  }

  static show(ctx: vscode.ExtensionContext): CacheLinePanel {
    if (CacheLinePanel._current && !CacheLinePanel._current._disposed) {
      CacheLinePanel._current._panel.reveal(vscode.ViewColumn.Beside, true);
      return CacheLinePanel._current;
    }
    const p = new CacheLinePanel(ctx);
    CacheLinePanel._current = p;
    return p;
  }

  render(finding: Finding): void {
    const info = parsePaddingFinding(finding);
    this._panel.title = `Cache-Line: ${info?.structName ?? 'struct'}`;
    this._panel.webview.html = this._html(finding, info);
  }

  dispose(): void {
    if (!this._disposed) this._panel.dispose();
  }

  private _html(
    finding: Finding,
    info: ReturnType<typeof parsePaddingFinding>,
  ): string {
    const structName  = info?.structName  ?? '(unknown struct)';
    const wastedBytes = info?.wastedBytes ?? 0;
    const totalSize   = info?.totalSize   ?? 0;

    // Build cache-line grid. Size is configurable for architectures with wider fetch blocks.
    const CACHE_LINE = vscode.workspace.getConfiguration('perfLens')
      .get<number>('architecture.cacheLineBytes', 64);
    const numLines   = Math.ceil(totalSize / CACHE_LINE);

    const lineGrids: string[] = [];
    for (let cl = 0; cl < numLines; ++cl) {
      const start = cl * CACHE_LINE;
      const end   = Math.min(start + CACHE_LINE, totalSize);
      const cells = Array.from({ length: end - start }, (_, i) =>
        `<div class="byte" title="byte ${start + i}" style="opacity:${i % 4 === 0 ? 1 : 0.6}"></div>`
      ).join('');
      lineGrids.push(`
        <div class="cl-label">Cache Line ${cl + 1} (bytes ${start}–${end - 1}):</div>
        <div class="cl-grid">${cells}</div>`);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px;
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         padding: 20px; max-width: 900px; }
  h2 { font-size: 1.1em; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  .warning { color: var(--vscode-editorWarning-foreground); font-weight: 600; margin-bottom: 12px; }
  .cl-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin: 12px 0 4px; }
  .cl-grid { display: flex; flex-wrap: wrap; gap: 2px; }
  .byte { width: 10px; height: 22px; background: var(--vscode-button-background);
          border-radius: 2px; cursor: default; }
  .action { margin-top: 20px; padding: 12px; background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .action h3 { margin: 0 0 8px; font-size: 0.9em; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
         background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 2px; }
</style>
</head>
<body>
<h2>${escHtml(structName)}</h2>
<div class="meta">Total size: ${totalSize} bytes · ${numLines} cache line${numLines !== 1 ? 's' : ''}</div>
<div class="warning">${wastedBytes} bytes wasted to padding</div>
${lineGrids.join('')}
<div class="action">
  <h3>Suggested action</h3>
  <p>Reorder fields from largest to smallest alignment to eliminate padding:</p>
  <code>// Prefer: double, int, short, char, char (largest to smallest alignment)</code>
  <p>Use the <code>perfLens.explainFinding</code> command with an LLM provider for a
     field-specific reorder suggestion.</p>
</div>
</body>
</html>`;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

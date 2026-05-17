import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import type { OptRemark, Finding, CompileResult } from '../sidecar/protocol';
import { readSnippet } from '../llm/manager';
import { logger } from '../util/logger';

export class LoopAnalyserPanel implements vscode.Disposable {
  private static _current?: LoopAnalyserPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;

  private constructor(ctx: vscode.ExtensionContext) {
    this._panel = vscode.window.createWebviewPanel(
      'perfLensLoopAnalyser',
      'Perf Lens: Loop Analyser',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.onDidDispose(() => {
      this._disposed = true;
      if (LoopAnalyserPanel._current === this) LoopAnalyserPanel._current = undefined;
    });
    ctx.subscriptions.push(this);
  }

  static show(ctx: vscode.ExtensionContext): LoopAnalyserPanel {
    if (LoopAnalyserPanel._current && !LoopAnalyserPanel._current._disposed) {
      LoopAnalyserPanel._current._panel.reveal(vscode.ViewColumn.Beside, true);
      return LoopAnalyserPanel._current;
    }
    const p = new LoopAnalyserPanel(ctx);
    LoopAnalyserPanel._current = p;
    return p;
  }

  async loadForFinding(
    finding: Finding,
    remarks: OptRemark[],
    sidecar: SidecarClient,
    signal: AbortSignal,
  ): Promise<void> {
    const snippet = readSnippet(finding.file, finding.line, 8);
    this._panel.title = `Loop: ${finding.title} — ${finding.file.split('/').pop()}:${finding.line}`;

    // Show loading state immediately
    this._panel.webview.html = this._loadingHtml(finding, snippet, remarks);

    // Compile the snippet in the background and update
    let compiled: CompileResult | undefined;
    try {
      const cfg          = vscode.workspace.getConfiguration('perfLens');
      const flags        = cfg.get<string[]>('godbolt.extraFlags', ['-O2', '-std=c++20']);
      const compilerPath = cfg.get<string>('compiler.path', '').trim();
      const params: Record<string, unknown> = { source: snippet, flags };
      if (compilerPath) params['compilerPath'] = compilerPath;
      compiled = await sidecar.request<CompileResult>('compileSnippet', params, signal);
    } catch (err) {
      if (signal.aborted) return;
      logger.debug('loop analyser: compileSnippet failed', err);
    }

    if (!this._disposed) {
      this._panel.webview.html = this._html(finding, snippet, remarks, compiled);
    }
  }

  dispose(): void {
    if (!this._disposed) this._panel.dispose();
  }

  private _loadingHtml(finding: Finding, snippet: string, remarks: OptRemark[]): string {
    return this._html(finding, snippet, remarks, undefined, true);
  }

  private _html(
    finding: Finding,
    snippet: string,
    remarks: OptRemark[],
    compiled: CompileResult | undefined,
    loading = false,
  ): string {
    const location = `${finding.file.split('/').pop()}:${finding.line}`;
    const remarkRows = remarks.map(r =>
      `<tr><td>${escHtml(r.pass)}</td><td>${escHtml(r.name)}</td>
       <td>${escHtml(r.message)}</td></tr>`
    ).join('') || '<tr><td colspan="3">No remarks at this location</td></tr>';

    const asmSection = loading
      ? '<p class="muted">Compiling…</p>'
      : compiled?.success
        ? `<pre class="asm-box">${escHtml(compiled.assembly.text || '(empty)')}</pre>`
        : compiled
          ? `<p class="err">Compilation failed</p><pre class="asm-box">${escHtml(compiled.stderr)}</pre>`
          : '<p class="muted">Assembly not available</p>';

    const mcaSection = compiled?.mca
      ? `<p>IPC: <strong>${compiled.mca.ipc.toFixed(2)}</strong> ·
         Cycles/iter: <strong>${compiled.mca.cyclesPerIteration.toFixed(2)}</strong> ·
         Bottleneck: <strong>${escHtml(compiled.mca.bottleneck || 'unknown')}</strong></p>`
      : '<p class="muted">Run with MCA enabled for throughput estimates</p>';

    const vwUsed = compiled?.assembly.vectorWidthUsed ?? 1;
    const vwLabel = ['1 (scalar)', '4 (SSE/128-bit)', '8 (AVX/256-bit)', '16 (AVX-512/512-bit)'];
    const vwText  = vwLabel[Math.log2(vwUsed)] ?? `${vwUsed}x`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px;
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         padding: 20px; max-width: 1000px; }
  h2 { font-size: 1em; font-weight: 600; margin-bottom: 4px; }
  .loc { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 16px; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  .tab { padding: 6px 16px; cursor: pointer; border: none; background: none;
         color: var(--vscode-foreground); font-size: 13px; border-bottom: 2px solid transparent; }
  .tab.active { border-bottom-color: var(--vscode-focusBorder); }
  .panel { display: none; }
  .panel.active { display: block; }
  pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
        white-space: pre-wrap; word-break: break-all; }
  .asm-box { background: var(--vscode-textCodeBlock-background);
             border: 1px solid var(--vscode-panel-border); border-radius: 4px;
             padding: 10px; max-height: 400px; overflow-y: auto; }
  table { border-collapse: collapse; width: 100%; }
  th,td { text-align: left; padding: 6px 10px;
          border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }
  th { color: var(--vscode-descriptionForeground); }
  .muted { color: var(--vscode-descriptionForeground); font-style: italic; }
  .err { color: var(--vscode-errorForeground); }
  .vw { margin-bottom: 8px; }
</style>
</head>
<body>
<h2>${escHtml(finding.title)}</h2>
<div class="loc">${escHtml(location)}</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('source')">Source</button>
  <button class="tab" onclick="showTab('asm')">Assembly</button>
  <button class="tab" onclick="showTab('mca')">MCA</button>
  <button class="tab" onclick="showTab('remarks')">Remarks (${remarks.length})</button>
</div>

<div id="source" class="panel active">
  <pre class="asm-box">${escHtml(snippet)}</pre>
  <p>${escHtml(finding.message)}</p>
</div>

<div id="asm" class="panel">
  <div class="vw">Vector width: <strong>${vwText}</strong></div>
  ${asmSection}
</div>

<div id="mca" class="panel">${mcaSection}</div>

<div id="remarks" class="panel">
  <table>
    <thead><tr><th>Pass</th><th>Name</th><th>Message</th></tr></thead>
    <tbody>${remarkRows}</tbody>
  </table>
</div>

<script>
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  event.target.classList.add('active');
}
</script>
</body>
</html>`;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

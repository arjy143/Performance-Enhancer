import * as path from 'path';
import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import type { CompileTraceResult, TraceEvent } from '../sidecar/protocol';

export class CompileTracePanel implements vscode.Disposable {
  private static _instance: CompileTracePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _subs: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, client: SidecarClient, filePath: string): CompileTracePanel {
    if (CompileTracePanel._instance) {
      CompileTracePanel._instance._panel.reveal();
      CompileTracePanel._instance._load(client, filePath);
      return CompileTracePanel._instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'perfLens.compileTrace',
      'Perf Lens: Compile Time',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    CompileTracePanel._instance = new CompileTracePanel(panel, ctx, client, filePath);
    return CompileTracePanel._instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    _ctx: vscode.ExtensionContext,
    client: SidecarClient,
    filePath: string,
  ) {
    void _ctx;
    this._panel = panel;
    this._panel.onDidDispose(() => {
      CompileTracePanel._instance = undefined;
      this.dispose();
    }, null, this._subs);

    this._panel.webview.html = this._loadingHtml(filePath);
    this._load(client, filePath);
  }

  private _load(client: SidecarClient, filePath: string): void {
    this._panel.title = `Compile Time: ${path.basename(filePath)}`;
    this._panel.webview.html = this._loadingHtml(filePath);

    void (async () => {
      try {
        const result = await client.request<CompileTraceResult>(
          'profileCompileTime', { file: filePath }, new AbortController().signal,
        );
        this._panel.webview.html = this._buildHtml(result, filePath);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this._panel.webview.html = this._errorHtml(msg, filePath);
      }
    })();
  }

  private _loadingHtml(filePath: string): string {
    return `<!DOCTYPE html><html><body style="background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);padding:20px">
<p>Compiling <code>${path.basename(filePath)}</code> with <code>-ftime-trace</code>...</p>
<p style="opacity:0.6">This may take a few seconds.</p></body></html>`;
  }

  private _errorHtml(msg: string, filePath: string): string {
    return `<!DOCTYPE html><html><body style="background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);padding:20px">
<p style="color:var(--vscode-errorForeground)">Failed to profile compile time for <code>${path.basename(filePath)}</code>:</p>
<pre style="white-space:pre-wrap;font-size:12px">${escHtml(msg)}</pre>
<p style="opacity:0.6">Ensure the compiler in <code>compile_commands.json</code> is Clang 9+ and that <code>compile_commands.json</code> exists in the workspace.</p>
</body></html>`;
  }

  private _buildHtml(r: CompileTraceResult, filePath: string): string {
    const ms = (us: number) => us >= 1000 ? `${(us / 1000).toFixed(0)} ms` : `${us} us`;
    const pct = (us: number, total: number) =>
      total > 0 ? ((us / total) * 100).toFixed(1) + '%' : '0%';

    const total = r.totalUs || (r.frontendUs + r.backendUs) || 1;

    const bar = (us: number, color: string, label: string) => {
      const w = Math.max(1, Math.round((us / total) * 400));
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <div style="width:${w}px;height:14px;background:${escHtml(color)};border-radius:2px;flex-shrink:0"></div>
        <span style="font-size:12px;opacity:0.9">${escHtml(label)}: <strong>${ms(us)}</strong> (${pct(us, total)})</span>
      </div>`;
    };

    const topList = (events: TraceEvent[], maxRows: number) => {
      if (events.length === 0) return '<p style="opacity:0.5;font-size:12px">None recorded.</p>';
      const maxDur = events[0]?.durUs || 1;
      return events.slice(0, maxRows).map(e => {
        const w = Math.max(2, Math.round((e.durUs / maxDur) * 280));
        const nameShort = e.name.length > 80 ? e.name.slice(0, 77) + '...' : e.name;
        return `<div style="margin:3px 0;display:flex;align-items:center;gap:8px" title="${escHtml(e.name)}">
          <div style="width:${w}px;height:10px;background:#4a8ec4;border-radius:1px;flex-shrink:0"></div>
          <span style="font-size:11px;font-family:monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(nameShort)}</span>
          <span style="font-size:11px;opacity:0.6;white-space:nowrap;margin-left:auto">${ms(e.durUs)}</span>
        </div>`;
      }).join('');
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Compile Time: ${escHtml(path.basename(filePath))}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
    padding: 18px 22px;
    line-height: 1.5;
  }
  h2 { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
  h3 { font-size: 12px; font-weight: 600; margin: 18px 0 8px; text-transform: uppercase;
       letter-spacing: 0.06em; opacity: 0.7; }
  .section { margin-bottom: 22px; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    margin-bottom: 18px;
  }
  .stat-card {
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 4px;
    padding: 10px 12px;
  }
  .stat-card .value { font-size: 20px; font-weight: 700; }
  .stat-card .label { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  .divider { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #454545); margin: 16px 0; }
</style>
</head>
<body>
<h2>Compile Time: ${escHtml(path.basename(filePath))}</h2>

<div class="summary-grid">
  <div class="stat-card">
    <div class="value">${ms(total)}</div>
    <div class="label">Total compile time</div>
  </div>
  <div class="stat-card">
    <div class="value">${ms(r.frontendUs)}</div>
    <div class="label">Frontend (parse + instantiate)</div>
  </div>
  <div class="stat-card">
    <div class="value">${ms(r.backendUs)}</div>
    <div class="label">Backend (codegen + opt)</div>
  </div>
</div>

<div class="section">
  <h3>Time breakdown</h3>
  ${bar(r.parseUs,       '#6a9fb5', 'Parse')}
  ${bar(r.instantiateUs,'#c5a000', 'Template instantiation')}
  ${bar(r.codegenUs,    '#4fa84f', 'Code generation')}
  ${bar(r.optUs,        '#a060c0', 'LLVM optimisation')}
  ${bar(r.frontendUs - r.parseUs - r.instantiateUs, '#888888', 'Other frontend')}
</div>

<hr class="divider">

<div class="section">
  <h3>Slowest template instantiations</h3>
  ${topList(r.instantiations, 15)}
</div>

<hr class="divider">

<div class="section">
  <h3>Slowest functions to codegen</h3>
  ${topList(r.codegenFns, 15)}
</div>

<hr class="divider">

<div class="section">
  <h3>Slowest include files</h3>
  ${topList(r.includes, 10)}
</div>

${r.remarksCount > 0 ? `<p style="font-size:11px;opacity:0.5;margin-top:8px">${r.remarksCount} optimisation remarks also ingested during this compile.</p>` : ''}
</body>
</html>`;
  }

  dispose(): void {
    this._subs.forEach(s => s.dispose());
    this._panel.dispose();
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

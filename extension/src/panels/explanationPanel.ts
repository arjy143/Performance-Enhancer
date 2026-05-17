import * as vscode from 'vscode';
import type { StreamChunk } from '../llm/types';

export class ExplanationPanel implements vscode.Disposable {
  private static _current?: ExplanationPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposed = false;

  private constructor(ctx: vscode.ExtensionContext, title: string) {
    this._panel = vscode.window.createWebviewPanel(
      'perfLensExplanation',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this._panel.webview.html = this._html();
    this._panel.onDidDispose(() => {
      this._disposed = true;
      if (ExplanationPanel._current === this) ExplanationPanel._current = undefined;
    });
    ctx.subscriptions.push(this);
  }

  static show(ctx: vscode.ExtensionContext, title: string): ExplanationPanel {
    if (ExplanationPanel._current && !ExplanationPanel._current._disposed) {
      ExplanationPanel._current._panel.title = title;
      ExplanationPanel._current._post({ type: 'reset', title });
      ExplanationPanel._current._panel.reveal(vscode.ViewColumn.Beside, true);
      return ExplanationPanel._current;
    }
    const panel = new ExplanationPanel(ctx, title);
    ExplanationPanel._current = panel;
    return panel;
  }

  async streamResult(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<void> {
    try {
      for await (const chunk of stream) {
        if (signal.aborted || this._disposed) break;
        if (chunk.type === 'text' && chunk.content) {
          this._post({ type: 'token', text: chunk.content });
        }
        if (chunk.type === 'done') break;
        if (chunk.type === 'error') {
          this._post({ type: 'error', text: chunk.content ?? 'Unknown error' });
          return;
        }
      }
      if (!this._disposed) this._post({ type: 'done' });
    } catch (err) {
      if (!this._disposed) {
        const msg = (err as Error).message ?? String(err);
        this._post({ type: 'error', text: msg });
      }
    }
  }

  showDegrade(reason: string): void {
    this._post({ type: 'degrade', text: reason });
  }

  startSection(heading: string): void {
    this._post({ type: 'section', heading });
  }

  dispose(): void {
    if (!this._disposed) this._panel.dispose();
  }

  private _post(msg: Record<string, unknown>): void {
    if (!this._disposed) {
      void this._panel.webview.postMessage(msg);
    }
  }

  private _html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    max-width: 820px;
    line-height: 1.7;
  }
  #title { font-size: 1.1em; font-weight: 600; margin-bottom: 12px; }
  #output { white-space: pre-wrap; word-break: break-word; }
  #status {
    margin-top: 12px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
  }
  .error { color: var(--vscode-errorForeground) !important; }
  .degrade { color: var(--vscode-editorWarning-foreground) !important; }
  #cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--vscode-foreground);
    animation: blink 0.8s step-end infinite;
    vertical-align: text-bottom;
    margin-left: 1px;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div id="title"></div>
<div id="output"></div><span id="cursor"></span>
<div id="status">Loading&#8230;</div>
<script>
  const vscode = acquireVsCodeApi();
  const output = document.getElementById('output');
  const status = document.getElementById('status');
  const cursor = document.getElementById('cursor');
  const titleEl = document.getElementById('title');

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'reset':
        output.textContent = '';
        output._activeSpan = null;
        status.textContent = 'Loading...';
        status.className = '';
        cursor.style.display = 'inline-block';
        if (data.title) titleEl.textContent = data.title;
        break;
      case 'token': {
        const target = output._activeSpan ?? output;
        target.textContent += data.text;
        break;
      }
      case 'section': {
        const div = document.createElement('div');
        div.style.cssText = 'font-weight:600;margin-top:18px;margin-bottom:4px;border-top:1px solid var(--vscode-editorWidget-border,#454545);padding-top:10px;';
        div.textContent = data.heading;
        output.appendChild(div);
        const span = document.createElement('span');
        span.style.whiteSpace = 'pre-wrap';
        output.appendChild(span);
        output._activeSpan = span;
        break;
      }
      case 'done':
        cursor.style.display = 'none';
        status.textContent = 'Complete.';
        break;
      case 'error':
        cursor.style.display = 'none';
        status.textContent = 'Error: ' + data.text;
        status.className = 'error';
        break;
      case 'degrade':
        cursor.style.display = 'none';
        status.textContent = data.text;
        status.className = 'degrade';
        break;
    }
  });
</script>
</body>
</html>`;
  }
}

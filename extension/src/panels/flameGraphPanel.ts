import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import type { FunctionHotness, ProfileMetadata } from '../sidecar/protocol';

export class FlameGraphPanel implements vscode.Disposable {
  private static _instance: FlameGraphPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _subs: vscode.Disposable[] = [];

  static show(
    ctx: vscode.ExtensionContext,
    client: SidecarClient,
    activeProfileId?: string,
  ): FlameGraphPanel {
    if (FlameGraphPanel._instance) {
      FlameGraphPanel._instance._panel.reveal();
      if (activeProfileId) void FlameGraphPanel._instance._refresh(activeProfileId);
      return FlameGraphPanel._instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'perfLens.flameGraph',
      'Perf Lens: Flame Graph',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    FlameGraphPanel._instance = new FlameGraphPanel(panel, client, ctx, activeProfileId);
    return FlameGraphPanel._instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _client: SidecarClient,
    private readonly _ctx: vscode.ExtensionContext,
    initialProfileId?: string,
  ) {
    void this._ctx; // suppress unused warning
    this._panel = panel;
    this._panel.onDidDispose(() => {
      FlameGraphPanel._instance = undefined;
      this.dispose();
    }, null, this._subs);

    this._panel.webview.onDidReceiveMessage(async (msg: { type: string; profileId?: string; event?: string }) => {
      if (msg.type === 'refresh') {
        await this._refresh(msg.profileId, msg.event);
      }
    }, null, this._subs);

    this._panel.webview.html = this._buildHtml([], undefined);
    if (initialProfileId) {
      void this._refresh(initialProfileId);
    }
  }

  async refresh(profileId: string, eventType = 'cycles'): Promise<void> {
    await this._refresh(profileId, eventType);
  }

  private async _refresh(profileId?: string, eventType = 'cycles'): Promise<void> {
    if (!profileId) {
      this._panel.webview.html = this._buildHtml([], undefined);
      return;
    }
    try {
      const fns = await this._client.request<FunctionHotness[]>('getTopFunctions', {
        profileId,
        n: 100,
        event: eventType,
      }, new AbortController().signal);

      const profiles = await this._client.request<ProfileMetadata[]>('listProfiles', {}, new AbortController().signal);
      const meta = profiles.find(p => p.id === profileId);

      this._panel.webview.html = this._buildHtml(fns, meta);
    } catch {
      this._panel.webview.html = this._buildHtml([], undefined);
    }
  }

  private _buildHtml(functions: FunctionHotness[], meta: ProfileMetadata | undefined): string {
    const title = meta ? `Perf Lens: Flame Graph - ${meta.label}` : 'Perf Lens: Flame Graph';
    const dataJson = JSON.stringify(functions);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${title}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-editorWidget-border, #454545);
    --accent: var(--vscode-focusBorder, #007acc);
    --hot1: #d73b2a;
    --hot2: #e8782e;
    --hot3: #f0a830;
    --hot4: #85c252;
    --cool: #4a8ec4;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, monospace);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  #toolbar {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  #toolbar span { opacity: 0.7; }
  #flame-container {
    flex: 1;
    overflow: auto;
    padding: 10px;
    position: relative;
  }
  #flame-canvas {
    display: block;
  }
  #tooltip {
    position: fixed;
    background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 3px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.1s;
    max-width: 400px;
    z-index: 100;
    white-space: nowrap;
  }
  #empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.5;
  }
</style>
</head>
<body>
<div id="toolbar">
  <strong>Flame Graph</strong>
  <span id="profile-label">${meta ? meta.label : 'No profile loaded'}</span>
  <span id="sample-count">${meta ? `${meta.totalSamples?.toLocaleString() ?? ''} samples` : ''}</span>
</div>
<div id="flame-container">
  <canvas id="flame-canvas"></canvas>
  <div id="empty-state" style="display:none">No profile data available. Import a profile first.</div>
</div>
<div id="tooltip"></div>
<script>
(function() {
  const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
  const data = ${dataJson};
  const canvas = document.getElementById('flame-canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const container = document.getElementById('flame-container');
  const emptyState = document.getElementById('empty-state');

  if (!data || data.length === 0) {
    canvas.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  // Sort by fraction descending
  const sorted = [...data].sort((a, b) => b.fraction - a.fraction);
  const total = sorted.reduce((s, f) => s + f.fraction, 0);

  const ROW_HEIGHT = 22;
  const MIN_FRACTION = 0.001;
  const visible = sorted.filter(f => f.fraction >= MIN_FRACTION);

  const W = container.clientWidth - 20;
  const H = visible.length * ROW_HEIGHT + 10;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  function heatColor(fraction) {
    if (fraction >= 0.15) return '#d73b2a';
    if (fraction >= 0.08) return '#e8782e';
    if (fraction >= 0.04) return '#f0a830';
    if (fraction >= 0.02) return '#85c252';
    return '#4a8ec4';
  }

  function textColor(bgHex) {
    const r = parseInt(bgHex.slice(1,3),16);
    const g = parseInt(bgHex.slice(3,5),16);
    const b = parseInt(bgHex.slice(5,7),16);
    return (r*299 + g*587 + b*114) / 1000 > 128 ? '#111' : '#eee';
  }

  // Draw each function as a horizontal bar proportional to its fraction.
  const bars = [];
  visible.forEach((fn, i) => {
    const y = i * ROW_HEIGHT + 5;
    const w = Math.max(2, fn.fraction / (visible[0].fraction || 1) * W * 0.95);
    const h = ROW_HEIGHT - 2;
    const color = heatColor(fn.fraction);

    ctx.fillStyle = color;
    ctx.fillRect(0, y, w, h);

    // Label
    const label = fn.function.length > 60
      ? fn.function.slice(0, 57) + '...'
      : fn.function;
    const pct = (fn.fraction * 100).toFixed(1) + '%';
    const text = pct + '  ' + label;

    ctx.fillStyle = textColor(color);
    ctx.font = '11px monospace';
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, w, h);
    ctx.clip();
    ctx.fillText(text, 4, y + 14);
    ctx.restore();

    bars.push({ x: 0, y, w, h, fn });
  });

  // Tooltip on mousemove
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let hit = null;
    for (const bar of bars) {
      if (mx >= bar.x && mx <= bar.x + bar.w &&
          my >= bar.y && my <= bar.y + bar.h) {
        hit = bar;
        break;
      }
    }

    if (hit) {
      tooltip.innerHTML =
        '<strong>' + hit.fn.function + '</strong><br>' +
        (hit.fn.fraction * 100).toFixed(2) + '% of ' + hit.fn.eventType + '<br>' +
        'Self: ' + hit.fn.selfCount.toLocaleString() + ' samples';
      tooltip.style.opacity = '1';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top  = (e.clientY - 10) + 'px';
    } else {
      tooltip.style.opacity = '0';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.opacity = '0';
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'update' && vscode) {
      vscode.postMessage({ type: 'refresh', profileId: msg.profileId, event: msg.event });
    }
  });
})();
</script>
</body>
</html>`;
  }

  dispose(): void {
    this._subs.forEach(s => s.dispose());
    this._panel.dispose();
  }
}

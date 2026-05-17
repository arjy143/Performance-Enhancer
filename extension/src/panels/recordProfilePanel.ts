import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ProfileManager } from '../profile/profileManager';
import { logger } from '../util/logger';

// Preset event sets indexed by preset name
const PRESETS: Record<string, { label: string; events: string[] }> = {
  hotspots: {
    label: 'General hotspots',
    events: ['cycles', 'instructions'],
  },
  memory: {
    label: 'Memory-bound analysis',
    events: ['cycles', 'L1-dcache-load-misses', 'LLC-load-misses', 'dTLB-load-misses'],
  },
  branches: {
    label: 'Branch-heavy analysis',
    events: ['cycles', 'branch-misses', 'branch-instructions'],
  },
  frontend: {
    label: 'Frontend stalls',
    events: ['cycles', 'iTLB-load-misses', 'frontend_retired.l1i_miss'],
  },
};

type PanelMessage =
  | { type: 'startRecording'; payload: { target: string; args: string; preset: string; freq: number; label: string } }
  | { type: 'cancel' };

export class RecordProfilePanel implements vscode.Disposable {
  private static _instance: RecordProfilePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _subs: vscode.Disposable[] = [];
  private _recording = false;

  static show(ctx: vscode.ExtensionContext, profileManager: ProfileManager): RecordProfilePanel {
    if (RecordProfilePanel._instance) {
      RecordProfilePanel._instance._panel.reveal();
      return RecordProfilePanel._instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'perfLens.recordProfile',
      'Perf Lens — Record Profile',
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    RecordProfilePanel._instance = new RecordProfilePanel(panel, profileManager, ctx);
    return RecordProfilePanel._instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _profileManager: ProfileManager,
    private readonly _ctx: vscode.ExtensionContext,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => {
      RecordProfilePanel._instance = undefined;
      this.dispose();
    }, null, this._subs);

    this._panel.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
      if (msg.type === 'startRecording') {
        await this._startRecording(msg.payload);
      } else if (msg.type === 'cancel') {
        this._panel.dispose();
      }
    }, null, this._subs);

    this._panel.webview.html = this._buildHtml();
  }

  private async _startRecording(opts: {
    target: string;
    args: string;
    preset: string;
    freq: number;
    label: string;
  }): Promise<void> {
    if (this._recording) return;
    this._recording = true;

    const preset = PRESETS[opts.preset] ?? PRESETS['hotspots'];
    const events = preset.events.join(',');
    const outFile = path.join(os.tmpdir(), `perf-lens-${Date.now()}.data`);
    const cmd = [
      'perf', 'record',
      `-F`, String(opts.freq),
      '-g', '--call-graph=dwarf',
      '-e', events,
      '-o', outFile,
      '--',
      opts.target,
      ...(opts.args ? opts.args.split(' ') : []),
    ].join(' ');

    logger.info(`RecordProfilePanel: running: ${cmd}`);

    // Show progress in the status bar while running
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Perf Lens: recording — ${opts.label}`,
        cancellable: false,
      },
      async () => {
        try {
          await this._runCommand(cmd);
          void vscode.window.showInformationMessage(
            `Perf Lens: recording complete. Importing profile…`,
          );
          await this._profileManager.importProfile(outFile, opts.label);
          void vscode.window.showInformationMessage(
            `Perf Lens: profile "${opts.label}" imported successfully.`,
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Perf Lens: recording failed — ${(err as Error).message}`,
          );
          logger.error('RecordProfilePanel: recording error:', (err as Error).message);
        } finally {
          this._recording = false;
          this._panel.dispose();
        }
      },
    );
  }

  private _runCommand(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process') as typeof import('child_process');
      exec(cmd, { timeout: 5 * 60 * 1000 }, (err) => {
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  private _buildHtml(): string {
    const presetOptions = Object.entries(PRESETS).map(([key, p]) =>
      `<option value="${key}">${escHtml(p.label)}</option>`,
    ).join('');
    const defaultFreq = vscode.workspace.getConfiguration('perfLens')
      .get<number>('profile.defaultFrequency', 999);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Record Profile</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; max-width: 520px; }
  h1 { font-size: 1.1em; margin-bottom: 16px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  input, select { width: 100%; padding: 4px 6px; margin-top: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); box-sizing: border-box; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  button { padding: 6px 16px; border: none; cursor: pointer; border-radius: 2px; }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .warn { color: var(--vscode-notificationsWarningIcon-foreground); margin-top: 12px; font-size: 0.85em; }
</style>
</head>
<body>
<h1>Record Profile</h1>
<label>Target binary
  <input id="target" type="text" placeholder="./build/bench" />
</label>
<label>Arguments
  <input id="args" type="text" placeholder="--benchmark_filter=Integrate" />
</label>
<label>Profile label
  <input id="label" type="text" placeholder="my-bench run" />
</label>
<label>Profile preset
  <select id="preset">${presetOptions}</select>
</label>
<label>Sampling frequency (Hz)
  <input id="freq" type="number" value="${defaultFreq}" min="1" max="9999" />
  <div class="hint">Higher = more detail, higher overhead. 999 Hz is recommended.</div>
</label>
<div class="warn">
  ⚠ Requires <code>perf</code> to be installed and your kernel to allow perf_event_open
  (<code>sudo sysctl kernel.perf_event_paranoid=1</code>).
  Linux only.
</div>
<div class="actions">
  <button class="primary" onclick="startRecording()">Start Recording</button>
  <button class="secondary" onclick="cancel()">Cancel</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function startRecording() {
    const target = document.getElementById('target').value.trim();
    if (!target) { alert('Please specify a target binary.'); return; }
    vscode.postMessage({
      type: 'startRecording',
      payload: {
        target,
        args:   document.getElementById('args').value.trim(),
        label:  document.getElementById('label').value.trim() || target,
        preset: document.getElementById('preset').value,
        freq:   parseInt(document.getElementById('freq').value, 10) || 999,
      },
    });
  }
  function cancel() { vscode.postMessage({ type: 'cancel' }); }
</script>
</body>
</html>`;
  }

  dispose(): void {
    this._subs.forEach(s => s.dispose());
    this._panel.dispose();
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

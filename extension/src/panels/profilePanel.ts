import * as vscode from 'vscode';
import { type ProfileManager } from '../profile/profileManager';
import type { ProfileMetadata, FunctionHotness } from '../sidecar/protocol';

export class ProfilePanel implements vscode.Disposable {
  private static _instance: ProfilePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _subs: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, profileManager: ProfileManager): ProfilePanel {
    if (ProfilePanel._instance) {
      ProfilePanel._instance._panel.reveal();
      return ProfilePanel._instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'perfLens.profilePanel',
      'Perf Lens : Profiles',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ProfilePanel._instance = new ProfilePanel(panel, profileManager);
    return ProfilePanel._instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _profileManager: ProfileManager,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => {
      ProfilePanel._instance = undefined;
      this.dispose();
    }, null, this._subs);

    this._panel.webview.onDidReceiveMessage(async (msg: { type: string; payload: unknown }) => {
      if (msg.type === 'importProfile') {
        await this._handleImport();
      } else if (msg.type === 'setActiveProfile') {
        this._profileManager.setActiveProfile(msg.payload as string);
        await this._refresh();
      } else if (msg.type === 'deleteProfile') {
        await this._profileManager.deleteProfile(msg.payload as string);
        await this._refresh();
      }
    }, null, this._subs);

    this._subs.push(
      _profileManager.onProfileChanged(() => void this._refresh()),
    );

    void this._refresh();
  }

  private async _handleImport(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: 'Select profile file',
      filters: {
        'Profile files': ['data', 'pb', 'gz', 'pprof', 'json'],
        'All files': ['*'],
      },
      canSelectMany: false,
    });
    if (!uris || uris.length === 0) return;
    const file = uris[0].fsPath;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Perf Lens: importing profile...' },
        () => this._profileManager.importProfile(file),
      );
      void vscode.window.showInformationMessage('Perf Lens: profile imported successfully.');
    } catch (err) {
      void vscode.window.showErrorMessage(`Perf Lens: profile import failed: ${(err as Error).message}`);
    }
    await this._refresh();
  }

  private async _refresh(): Promise<void> {
    await this._profileManager.refreshProfiles();
    const profiles = this._profileManager.profiles;
    const activeId = this._profileManager.activeProfileId;
    const topFunctions = await this._profileManager.getTopFunctions(20);
    this._panel.webview.html = this._buildHtml(profiles, activeId, topFunctions);
  }

  private _buildHtml(
    profiles: readonly ProfileMetadata[],
    activeId: string | undefined,
    topFunctions: FunctionHotness[],
  ): string {
    const profileRows = profiles.map(p => {
      const date    = new Date(p.recordedAt * 1000).toLocaleString();
      const isActive = p.id === activeId;
      const activeLabel = isActive ? ' <strong>(active)</strong>' : '';
      return `
        <tr class="${isActive ? 'active-row' : ''}">
          <td>${escHtml(p.label)}${activeLabel}</td>
          <td>${escHtml(p.sourceProfiler)}</td>
          <td>${p.totalSamples.toLocaleString()}</td>
          <td>${date}</td>
          <td>
            ${isActive ? '' : `<button onclick="setActive('${p.id}')">Set Active</button>`}
            <button onclick="deleteProfile('${p.id}')">Delete</button>
          </td>
        </tr>`;
    }).join('');

    const fnRows = topFunctions.map(f => {
      const pct = (f.fraction * 100).toFixed(1);
      return `<tr>
        <td>${escHtml(f.function)}</td>
        <td class="pct">${pct}%</td>
        <td>${f.selfCount.toLocaleString()}</td>
      </tr>`;
    }).join('');

    const hotSection = topFunctions.length > 0 ? `
      <h2>Top Functions</h2>
      <table class="fn-table">
        <thead><tr><th>Function</th><th>Self %</th><th>Samples</th></tr></thead>
        <tbody>${fnRows}</tbody>
      </table>` : activeId ? '<p class="dim">No hotness data for active profile.</p>' : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Perf Lens : Profiles</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px; }
  h1 { font-size: 1.2em; margin-bottom: 8px; }
  h2 { font-size: 1em; margin: 16px 0 6px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; padding: 4px 8px; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .active-row { background: var(--vscode-list-hoverBackground); }
  .pct { font-variant-numeric: tabular-nums; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; margin-left: 4px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .dim { color: var(--vscode-descriptionForeground); font-style: italic; }
  .toolbar { margin-bottom: 12px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
<h1>Profiles</h1>
<div class="toolbar">
  <button onclick="importProfile()">Import Profile...</button>
</div>
${profiles.length === 0
  ? '<p class="empty">No profiles loaded. Use <em>Import Profile...</em> to load a perf or pprof file.</p>'
  : `<table>
      <thead><tr><th>Label</th><th>Profiler</th><th>Samples</th><th>Recorded</th><th>Actions</th></tr></thead>
      <tbody>${profileRows}</tbody>
    </table>`}
${hotSection}
<script>
  const vscode = acquireVsCodeApi();
  function importProfile()           { vscode.postMessage({ type: 'importProfile' }); }
  function setActive(id)             { vscode.postMessage({ type: 'setActiveProfile', payload: id }); }
  function deleteProfile(id) {
    if (confirm('Delete this profile?')) vscode.postMessage({ type: 'deleteProfile', payload: id });
  }
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

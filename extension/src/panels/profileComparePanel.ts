import * as vscode from 'vscode';
import { type ProfileManager } from '../profile/profileManager';
import type { FunctionHotness, ProfileMetadata } from '../sidecar/protocol';

interface CompareRow {
  function:    string;
  beforePct:   number;
  afterPct:    number;
  deltaPct:    number;
  isRegression: boolean;   // delta > REGRESSION_THRESHOLD
}

const REGRESSION_THRESHOLD = 0.02;  // absolute fraction, 2 percentage points

export class ProfileComparePanel implements vscode.Disposable {
  private static _instance: ProfileComparePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _subs: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, profileManager: ProfileManager): ProfileComparePanel {
    if (ProfileComparePanel._instance) {
      ProfileComparePanel._instance._panel.reveal();
      return ProfileComparePanel._instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'perfLens.compareProfiles',
      'Perf Lens: Compare Profiles',
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    );
    ProfileComparePanel._instance = new ProfileComparePanel(panel, profileManager);
    return ProfileComparePanel._instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _profileManager: ProfileManager,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => {
      ProfileComparePanel._instance = undefined;
      this.dispose();
    }, null, this._subs);

    this._panel.webview.onDidReceiveMessage(async (msg: { type: string; beforeId: string; afterId: string }) => {
      if (msg.type === 'compare') {
        await this._runComparison(msg.beforeId, msg.afterId);
      }
    }, null, this._subs);

    void this._showSelector();
  }

  private async _showSelector(): Promise<void> {
    await this._profileManager.refreshProfiles();
    const profiles = this._profileManager.profiles;
    this._panel.webview.html = this._buildSelectorHtml(profiles);
  }

  private async _runComparison(beforeId: string, afterId: string): Promise<void> {
    const [before, after] = await Promise.all([
      this._profileManager.getTopFunctions(50, 'cycles')
        .then(() => this._fetchFunctions(beforeId)),
      this._fetchFunctions(afterId),
    ]);

    const rows = this._buildCompareRows(before, after);
    const profiles = this._profileManager.profiles;
    const beforeMeta = profiles.find(p => p.id === beforeId);
    const afterMeta  = profiles.find(p => p.id === afterId);
    this._panel.webview.html = this._buildResultHtml(rows, beforeMeta, afterMeta);
  }

  private async _fetchFunctions(profileId: string): Promise<FunctionHotness[]> {
    // Temporarily swap active profile to query it, then restore
    const prev = this._profileManager.activeProfileId;
    this._profileManager.setActiveProfile(profileId);
    const fns = await this._profileManager.getTopFunctions(50);
    this._profileManager.setActiveProfile(prev);
    return fns;
  }

  private _buildCompareRows(
    before: FunctionHotness[],
    after:  FunctionHotness[],
  ): CompareRow[] {
    const beforeMap = new Map(before.map(f => [f.function, f.fraction]));
    const afterMap  = new Map(after.map(f => [f.function, f.fraction]));
    const allFns    = new Set([...beforeMap.keys(), ...afterMap.keys()]);

    const rows: CompareRow[] = [];
    for (const fn of allFns) {
      const b = beforeMap.get(fn) ?? 0;
      const a = afterMap.get(fn)  ?? 0;
      const delta = a - b;
      rows.push({
        function:    fn,
        beforePct:   b,
        afterPct:    a,
        deltaPct:    delta,
        isRegression: delta > REGRESSION_THRESHOLD,
      });
    }
    // Sort: regressions first, then by |delta| descending
    rows.sort((a, b) => {
      if (a.isRegression !== b.isRegression) return a.isRegression ? -1 : 1;
      return Math.abs(b.deltaPct) - Math.abs(a.deltaPct);
    });
    return rows;
  }

  private _buildSelectorHtml(profiles: readonly ProfileMetadata[]): string {
    if (profiles.length < 2) {
      return simpleHtml('<p>At least two profiles are required to compare. Import more profiles first.</p>');
    }
    const options = profiles.map(p =>
      `<option value="${p.id}">${escHtml(p.label)} (${new Date(p.recordedAt * 1000).toLocaleDateString()})</option>`,
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Compare Profiles</title>
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px;max-width:500px}
  label{display:block;margin-top:12px;font-weight:600}
  select{width:100%;padding:4px;margin-top:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
  button{margin-top:16px;padding:6px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;border-radius:2px}
</style></head>
<body>
<h1 style="font-size:1.1em">Compare Profiles</h1>
<label>Baseline (before)
  <select id="before">${options}</select>
</label>
<label>Candidate (after)
  <select id="after">${options}</select>
</label>
<button onclick="compare()">Compare</button>
<script>
const vscode = acquireVsCodeApi();
function compare(){
  vscode.postMessage({type:'compare',beforeId:document.getElementById('before').value,afterId:document.getElementById('after').value});
}
</script>
</body></html>`;
  }

  private _buildResultHtml(
    rows: CompareRow[],
    beforeMeta: ProfileMetadata | undefined,
    afterMeta:  ProfileMetadata | undefined,
  ): string {
    const tableRows = rows.slice(0, 40).map(r => {
      const deltaStr = (r.deltaPct >= 0 ? '+' : '') + (r.deltaPct * 100).toFixed(1) + '%';
      const cls = r.isRegression ? 'regression' : r.deltaPct < -REGRESSION_THRESHOLD ? 'improvement' : '';
      return `<tr class="${cls}">
        <td>${escHtml(r.function)}</td>
        <td class="num">${(r.beforePct * 100).toFixed(1)}%</td>
        <td class="num">${(r.afterPct * 100).toFixed(1)}%</td>
        <td class="num">${deltaStr}</td>
        <td>${r.isRegression ? 'regression' : r.deltaPct < -REGRESSION_THRESHOLD ? 'improved' : ''}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Profile Comparison</title>
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:12px}
  h1{font-size:1.1em}
  table{border-collapse:collapse;width:100%}
  th{text-align:left;padding:4px 8px;background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
  td{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border)}
  .num{font-variant-numeric:tabular-nums;text-align:right}
  .regression{background:rgba(200,0,0,0.12)}
  .improvement{background:rgba(0,180,0,0.10)}
  .subtitle{color:var(--vscode-descriptionForeground);font-size:0.9em;margin-bottom:10px}
</style></head>
<body>
<h1>Profile Comparison</h1>
<div class="subtitle">
  Baseline: <strong>${escHtml(beforeMeta?.label ?? 'unknown')}</strong> vs
  Candidate: <strong>${escHtml(afterMeta?.label ?? 'unknown')}</strong>
</div>
<table>
  <thead><tr><th>Function</th><th>Before</th><th>After</th><th>Δ</th><th></th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>
</body></html>`;
  }

  dispose(): void {
    this._subs.forEach(s => s.dispose());
    this._panel.dispose();
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function simpleHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)}</style>
</head><body>${body}</body></html>`;
}

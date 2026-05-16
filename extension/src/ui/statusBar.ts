import * as vscode from 'vscode';

export class PerfLensStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;

  constructor(ctx: vscode.ExtensionContext) {
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._item.command = 'perfLens.showPerfPanel';
    this._item.name    = 'Perf Lens';
    ctx.subscriptions.push(this._item);
    this.setStarting();
    this._item.show();
  }

  setStarting(): void {
    this._item.text    = '$(loading~spin) Perf Lens';
    this._item.tooltip = 'Perf Lens: starting…';
    this._item.backgroundColor = undefined;
  }

  setReady(issueCount = 0): void {
    this._item.text = issueCount > 0
      ? `$(zap) Perf Lens: ${issueCount} issue${issueCount === 1 ? '' : 's'}`
      : '$(zap) Perf Lens: ready';
    this._item.tooltip = 'Perf Lens: click to open Performance Panel';
    this._item.backgroundColor = undefined;
  }

  setError(message: string): void {
    this._item.text    = '$(error) Perf Lens: error';
    this._item.tooltip = `Perf Lens: ${message}`;
    this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  setNoSidecar(): void {
    this._item.text    = '$(warning) Perf Lens: sidecar missing';
    this._item.tooltip = 'Perf Lens: sidecar binary not found — see "Perf Lens" output channel';
    this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void { this._item.dispose(); }
}

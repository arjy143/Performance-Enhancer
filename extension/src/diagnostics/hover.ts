import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import { type OptRemark, RemarkType, CATEGORY_LABELS } from '../sidecar/protocol';
import { logger } from '../util/logger';

const TYPE_LABEL: Record<RemarkType, string> = {
  [RemarkType.Passed]:   'Optimised',
  [RemarkType.Missed]:   'Missed',
  [RemarkType.Analysis]: 'Analysis',
};

function remarkToMarkdown(r: OptRemark): string {
  const type = TYPE_LABEL[r.type] ?? 'Unknown';
  const cat  = CATEGORY_LABELS[r.category] ?? 'Other';
  const stale = r.isStale ? ' _(stale)_' : '';
  return `**$(perf-lens-icon) Perf Lens** · ${type}${stale}

${r.message}

| | |
|---|---|
| Category | ${cat} |
| Pass | \`${r.pass}\` |
| Function | \`${r.function}\` |
| Build | \`${r.buildId}\` |`;
}

export class RemarksHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  constructor(private readonly _client: SidecarClient) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const file = document.uri.fsPath;
    const line = position.line + 1;

    let remarks: OptRemark[];
    try {
      const signal = abortOnCancel(token);
      remarks = await this._client.request<OptRemark[]>('getRemarks', { file, line }, signal);
    } catch (err) {
      if (isCancellation(err)) return undefined;
      logger.debug('hover: getRemarks failed', err);
      return undefined;
    }

    if (remarks.length === 0) return undefined;

    const md = new vscode.MarkdownString(
      remarks.map(remarkToMarkdown).join('\n\n---\n\n'),
      true,
    );
    md.isTrusted = true;

    const range = document.lineAt(position.line).range;
    return new vscode.Hover(md, range);
  }

  dispose(): void { /* nothing owned */ }
}

function abortOnCancel(token: vscode.CancellationToken): AbortSignal {
  const ctrl = new AbortController();
  token.onCancellationRequested(() => ctrl.abort());
  return ctrl.signal;
}

function isCancellation(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

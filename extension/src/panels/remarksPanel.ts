import * as vscode from 'vscode';
import { type SidecarClient } from '../sidecar/client';
import { type OptRemark, RemarkType, RemarkCategory, CATEGORY_LABELS } from '../sidecar/protocol';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

type TreeNode = CategoryNode | FileNode | RemarkNode;

class CategoryNode extends vscode.TreeItem {
  readonly kind = 'category' as const;
  constructor(readonly category: RemarkCategory) {
    super(CATEGORY_LABELS[category], vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'remarkCategory';
  }
}

class FileNode extends vscode.TreeItem {
  readonly kind = 'file' as const;
  constructor(
    readonly file: string,
    readonly category: RemarkCategory,
  ) {
    super(vscode.Uri.file(file), vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'remarkFile';
  }
}

class RemarkNode extends vscode.TreeItem {
  readonly kind = 'remark' as const;
  constructor(readonly remark: OptRemark) {
    const label = `L${remark.line}: ${remark.name}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = remark.message.slice(0, 80);
    this.tooltip = remark.message;
    this.command = {
      title:     'Go to remark',
      command:   'perfLens.goToRemark',
      arguments: [remark],
    };
    this.iconPath = remarkIcon(remark.type);
    if (remark.isStale) {
      this.contextValue = 'staleRemark';
    } else {
      this.contextValue = 'remark';
    }
  }
}

function remarkIcon(type: RemarkType): vscode.ThemeIcon {
  switch (type) {
    case RemarkType.Missed:   return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case RemarkType.Passed:   return new vscode.ThemeIcon('check',   new vscode.ThemeColor('editorInfo.foreground'));
    default:                  return new vscode.ThemeIcon('info');
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

export class RemarksTreeDataProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // category → file → remarks
  private _tree = new Map<RemarkCategory, Map<string, OptRemark[]>>();

  constructor(private readonly _client: SidecarClient) {}

  refresh(): void {
    void this._load();
  }

  private async _load(): Promise<void> {
    let files: string[];
    try {
      files = await this._client.request<string[]>('getRemarkedFiles', {});
    } catch (err) {
      logger.warn('remarks panel: getRemarkedFiles failed', err);
      return;
    }

    const next = new Map<RemarkCategory, Map<string, OptRemark[]>>();

    await Promise.all(files.map(async file => {
      let remarks: OptRemark[];
      try {
        remarks = await this._client.request<OptRemark[]>('getRemarks', { file });
      } catch {
        return;
      }
      for (const r of remarks) {
        if (!next.has(r.category)) next.set(r.category, new Map());
        const byFile = next.get(r.category)!;
        if (!byFile.has(r.file)) byFile.set(r.file, []);
        byFile.get(r.file)!.push(r);
      }
    }));

    this._tree = next;
    this._onDidChange.fire();
  }

  getTreeItem(el: TreeNode): vscode.TreeItem { return el; }

  getChildren(el?: TreeNode): TreeNode[] {
    if (!el) {
      // root: one node per category that has data
      return [...this._tree.keys()]
        .sort((a, b) => a - b)
        .map(cat => new CategoryNode(cat));
    }
    if (el.kind === 'category') {
      const byFile = this._tree.get(el.category);
      if (!byFile) return [];
      return [...byFile.keys()].sort().map(f => new FileNode(f, el.category));
    }
    if (el.kind === 'file') {
      const byFile = this._tree.get(el.category);
      const remarks = byFile?.get(el.file) ?? [];
      return remarks
        .sort((a, b) => a.line - b.line)
        .map(r => new RemarkNode(r));
    }
    return [];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

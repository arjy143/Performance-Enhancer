/* eslint-disable @typescript-eslint/no-unused-vars */

const _mockDiagCollection = {
  set: jest.fn(),
  delete: jest.fn(),
  clear: jest.fn(),
  dispose: jest.fn(),
};

export const languages = {
  createDiagnosticCollection: jest.fn(() => _mockDiagCollection),
  registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
};

const _mockWebview = {
  postMessage: jest.fn(() => Promise.resolve(true)),
  html: '',
  onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() })),
};

const _mockWebviewPanel = {
  webview: _mockWebview,
  title: '',
  reveal: jest.fn(),
  onDidDispose: jest.fn((_cb: () => void) => ({ dispose: jest.fn() })),
  dispose: jest.fn(),
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_line: string) => { /* noop */ },
    show: () => { /* noop */ },
    dispose: () => { /* noop */ },
  }),
  showWarningMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  showErrorMessage:   (..._args: unknown[]) => Promise.resolve(undefined),
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(undefined),
  activeTextEditor: undefined as undefined,
  onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
  createStatusBarItem: (_alignment: number, _priority: number) => ({
    show: () => { /* noop */ },
    dispose: () => { /* noop */ },
    text: '',
    tooltip: '' as string | undefined,
    command: '' as string | undefined,
    backgroundColor: undefined as unknown,
    name: '',
  }),
  registerTreeDataProvider: jest.fn(() => ({ dispose: jest.fn() })),
  createWebviewPanel: jest.fn(() => _mockWebviewPanel),
};

export const workspace = {
  workspaceFolders: undefined as undefined,
  onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  getConfiguration: jest.fn(() => ({
    get: jest.fn((_key: string, defaultVal?: unknown) => defaultVal),
  })),
  createFileSystemWatcher: jest.fn(() => ({
    onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDelete: jest.fn(() => ({ dispose: jest.fn() })),
    dispose: jest.fn(),
  })),
  applyEdit: jest.fn(() => Promise.resolve(true)),
};

export const commands = {
  registerCommand: (_command: string, _callback: () => void) => ({ dispose: () => { /* noop */ } }),
};

export const env = {
  openExternal: (_uri: unknown) => Promise.resolve(true),
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export const DiagnosticTag = { Deprecated: 2, Unnecessary: 1 } as const;

export class Diagnostic {
  tags: number[] = [];
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: number,
  ) {}
}

export class Range {
  constructor(
    public startLine: number, public startChar: number,
    public endLine:   number, public endChar:   number,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class Uri {
  static parse(str: string): { toString: () => string } {
    return { toString: () => str };
  }
  static file(str: string): { fsPath: string; toString: () => string } {
    return { fsPath: str, toString: () => str };
  }
}

export class EventEmitter {
  event = jest.fn();
  fire = jest.fn();
  dispose = jest.fn();
}

export class MarkdownString {
  isTrusted = false;
  constructor(public value = '', _supportThemes = false) {}
}

export class Hover {
  constructor(public contents: MarkdownString, public range?: Range) {}
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  command?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  collapsibleState: number;
  constructor(_labelOrUri: unknown, collapsibleState = 0) {
    this.collapsibleState = collapsibleState;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export const ViewColumn = { One: 1, Two: 2, Three: 3, Beside: -2, Active: -1 } as const;

export const CodeActionKind = {
  QuickFix:   { value: 'quickfix',  contains: () => true },
  Refactor:   { value: 'refactor',  contains: () => true },
  Empty:      { value: '',          contains: () => true },
} as const;

export class CodeAction {
  diagnostics?: unknown[];
  isPreferred?: boolean;
  command?: unknown;
  edit?: unknown;
  constructor(public title: string, public kind?: unknown) {}
}

// WorkspaceEdit — supports insert and replace, get() returns TextEdit[]
export class WorkspaceEdit {
  private _entries = new Map<string, TextEdit[]>();

  replace(uri: { toString(): string }, range: Range, newText: string): void {
    const key = uri.toString();
    if (!this._entries.has(key)) this._entries.set(key, []);
    this._entries.get(key)!.push(new TextEdit(range, newText));
  }

  insert(uri: { toString(): string }, pos: Position, newText: string): void {
    const key = uri.toString();
    if (!this._entries.has(key)) this._entries.set(key, []);
    this._entries.get(key)!.push(new TextEdit(new Range(pos.line, pos.character, pos.line, pos.character), newText));
  }

  get(uri: { toString(): string }): TextEdit[] {
    return this._entries.get(uri.toString()) ?? [];
  }
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}
}

export class Position {
  constructor(public line: number, public character: number) {}
}


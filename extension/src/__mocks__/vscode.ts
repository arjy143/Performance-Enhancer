/* eslint-disable @typescript-eslint/no-unused-vars */

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
  createStatusBarItem: (_alignment: number, _priority: number) => ({
    show: () => { /* noop */ },
    dispose: () => { /* noop */ },
    text: '',
    tooltip: '' as string | undefined,
    command: '' as string | undefined,
    backgroundColor: undefined as unknown,
    name: '',
  }),
};

export const workspace = {
  workspaceFolders: undefined as undefined,
};

export const commands = {
  registerCommand: (_command: string, _callback: () => void) => ({ dispose: () => { /* noop */ } }),
};

export const env = {
  openExternal: (_uri: unknown) => Promise.resolve(true),
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class Uri {
  static parse(str: string): { toString: () => string } {
    return { toString: () => str };
  }
  static file(str: string): { fsPath: string; toString: () => string } {
    return { fsPath: str, toString: () => str };
  }
}

export const DiagnosticTag = { Deprecated: 2, Unnecessary: 1 } as const;

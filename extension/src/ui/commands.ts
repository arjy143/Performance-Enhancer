import * as vscode from 'vscode';
import { logger } from '../util/logger';

export function registerCommands(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('perfLens.analyseFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Perf Lens: no active editor.');
        return;
      }
      logger.info(`Analyse file: ${editor.document.uri.fsPath}`);
      void vscode.window.showInformationMessage('Perf Lens: file analysis available in Phase 2.');
    }),

    vscode.commands.registerCommand('perfLens.showPerfPanel', () => {
      logger.info('Show performance panel requested');
      void vscode.window.showInformationMessage('Perf Lens: performance panel available in Phase 2.');
    }),

    // perfLens.regenerateRemarks is registered in _initialiseAsync once the
    // sidecar client is available. Register a stub here so VS Code doesn't
    // complain about an unregistered command if the user triggers it early.
    vscode.commands.registerCommand('perfLens.goToRemark', async (remark: { file: string; line: number }) => {
      const uri = vscode.Uri.file(remark.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, remark.line - 1);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(line, 0, line, 0),
      });
    }),
  );
}

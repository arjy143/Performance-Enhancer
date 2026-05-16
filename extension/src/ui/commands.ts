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
  );
}

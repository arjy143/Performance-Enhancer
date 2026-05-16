import * as vscode from 'vscode';
import { logger } from '../util/logger';

export function registerCommands(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    // perfLens.analyseFile and perfLens.showPerfPanel are registered in
    // _initialiseAsync once the sidecar client is available.

    // goToRemark can be triggered from the remarks tree before sidecar is
    // fully ready, so register it here as it needs no sidecar call.
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

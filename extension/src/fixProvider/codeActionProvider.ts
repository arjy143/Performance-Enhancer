import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import type { Finding } from '../sidecar/protocol';
import { SUPPORTED_RULE_IDS, buildPatch } from './patchTemplates';
import { logger } from '../util/logger';

export class PerfLensCodeActionProvider implements vscode.CodeActionProvider, vscode.Disposable {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  constructor(private readonly _client: SidecarClient) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.source !== 'perf-lens-static') continue;
      const ruleId = typeof diag.code === 'string' ? diag.code : undefined;
      if (!ruleId || !SUPPORTED_RULE_IDS.has(ruleId)) continue;

      // Reconstruct a minimal Finding from the diagnostic
      const finding: Finding = {
        ruleId,
        title:      diag.message,
        message:    diag.message,
        file:       document.uri.fsPath,
        line:       diag.range.start.line + 1,
        column:     diag.range.start.character,
        category:   0,
        confidence: 0,
        buildId:    '',
      };

      const patch = buildPatch(finding);
      if (!patch) continue;

      // "Apply Fix" action
      const applyAction = new vscode.CodeAction(
        `Perf Lens: ${patch.description}`,
        vscode.CodeActionKind.QuickFix,
      );
      applyAction.diagnostics  = [diag];
      applyAction.isPreferred  = true;
      applyAction.command = {
        title:   'Apply Perf Lens fix',
        command: 'perfLens.applyFix',
        arguments: [finding],
      };
      actions.push(applyAction);

      // "Verify Only" action (shows asm diff without applying)
      const verifyAction = new vscode.CodeAction(
        `Perf Lens: Verify fix for ${ruleId} (preview asm diff)`,
        vscode.CodeActionKind.QuickFix,
      );
      verifyAction.diagnostics = [diag];
      verifyAction.command = {
        title:   'Verify fix (asm diff)',
        command: 'perfLens.verifyFix',
        arguments: [finding],
      };
      actions.push(verifyAction);
    }
    void range; void document; // satisfy linter
    return actions;
  }

  dispose(): void { /* nothing owned */ }
}

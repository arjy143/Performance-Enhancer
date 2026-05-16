import * as fs from 'fs';
import * as vscode from 'vscode';
import type { SidecarClient } from '../sidecar/client';
import type { CompileResult, AsmDiff } from '../sidecar/protocol';
import type { PatchResult } from './patchTemplates';
import { logger } from '../util/logger';

export type VerificationPredicate = PatchResult['verificationPredicate'];

export interface VerificationResult {
  verified: boolean;
  reason: string;
  before: CompileResult;
  after: CompileResult;
  diff: AsmDiff;
}

// Apply the edit to a temporary string buffer and return the patched source.
async function applyEditToString(original: string, edit: vscode.WorkspaceEdit, uri: vscode.Uri): Promise<string> {
  const entries = edit.get(uri);
  if (entries.length === 0) return original;

  const lines = original.split('\n');

  // Sort edits in reverse order so line indices remain valid.
  const sorted = [...entries].sort((a, b) => b.range.start.line - a.range.start.line);

  for (const textEdit of sorted) {
    const { range, newText } = textEdit;
    const startLine = range.start.line;
    const endLine   = range.end.line;

    if (range.end.character === Number.MAX_SAFE_INTEGER) {
      // Full-line replacement
      lines[startLine] = newText;
      if (endLine > startLine) lines.splice(startLine + 1, endLine - startLine);
    } else {
      // Insertion (character 0, same line = insert before)
      if (range.start.character === 0 && range.start.line === range.end.line && range.end.character === 0) {
        lines.splice(startLine, 0, ...newText.split('\n').slice(0, -1));
      } else {
        lines[startLine] = newText;
      }
    }
  }

  return lines.join('\n');
}

export async function verifyPatch(
  finding: { file: string; line: number },
  patch: PatchResult,
  sidecar: SidecarClient,
  signal: AbortSignal,
): Promise<VerificationResult | undefined> {
  // Read original source
  let originalSource: string;
  try {
    originalSource = fs.readFileSync(finding.file, 'utf8');
  } catch {
    logger.warn('verifier: cannot read file', finding.file);
    return undefined;
  }

  const uri = vscode.Uri.file(finding.file);

  // Derive patched source by applying the edit to a string buffer
  const patchedSource = await applyEditToString(originalSource, patch.edit, uri);

  // Get compiler flags from config
  const cfg   = vscode.workspace.getConfiguration('perfLens');
  const flags = cfg.get<string[]>('godbolt.extraFlags', ['-O2', '-std=c++20']);

  // Compile both versions
  let before: CompileResult;
  let after:  CompileResult;
  try {
    [before, after] = await Promise.all([
      sidecar.request<CompileResult>('compileSnippet', { source: originalSource, flags }, signal),
      sidecar.request<CompileResult>('compileSnippet', { source: patchedSource,  flags }, signal),
    ]);
  } catch (err) {
    if (signal.aborted) return undefined;
    logger.warn('verifier: compile failed', err);
    return undefined;
  }

  if (!before.success || !after.success) {
    return {
      verified: false,
      reason: !before.success ? 'Original source did not compile' : 'Patched source did not compile',
      before, after,
      diff: { changes: [], instructionsBefore: 0, instructionsAfter: 0,
              vectorWidthBefore: 1, vectorWidthAfter: 1, vectorisationImproved: false, summary: '' },
    };
  }

  // Diff the assemblies
  const diff = await sidecar.request<AsmDiff>('diffAsm', {
    beforeText:         before.assembly.text,
    afterText:          after.assembly.text,
    vectorWidthBefore:  before.assembly.vectorWidthUsed,
    vectorWidthAfter:   after.assembly.vectorWidthUsed,
  }, signal);

  // Check predicate
  const { verified, reason } = checkPredicate(patch.verificationPredicate, before, after, diff);
  return { verified, reason, before, after, diff };
}

function checkPredicate(
  predicate: VerificationPredicate,
  before: CompileResult,
  after: CompileResult,
  diff: AsmDiff,
): { verified: boolean; reason: string } {
  switch (predicate) {
    case 'vectorisation_enabled':
      if (diff.vectorisationImproved)
        return { verified: true, reason: `Vector width: ${diff.vectorWidthBefore}x → ${diff.vectorWidthAfter}x` };
      return { verified: false, reason: 'Vectorisation width did not improve' };

    case 'no_endl_call':
      if (!after.assembly.text.includes('endl'))
        return { verified: true, reason: 'endl call eliminated from assembly' };
      return { verified: false, reason: 'endl still present in assembly' };

    case 'constexpr_eval':
      // If call count decreased (function body collapsed), treat as verified
      if (diff.instructionsAfter < diff.instructionsBefore)
        return { verified: true, reason: `Instructions reduced by ${diff.instructionsBefore - diff.instructionsAfter}` };
      return { verified: false, reason: 'Instruction count did not decrease — constexpr evaluation not confirmed' };

    case 'none':
      // No verification predicate — always "verified" (apply-only)
      return { verified: true, reason: 'Patch applied (no verification predicate for this rule)' };
  }
}

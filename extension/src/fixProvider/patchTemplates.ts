import * as vscode from 'vscode';
import * as fs from 'fs';
import type { Finding } from '../sidecar/protocol';

export interface PatchResult {
  edit: vscode.WorkspaceEdit;
  description: string;
  verificationPredicate: 'vectorisation_enabled' | 'no_endl_call' | 'constexpr_eval' | 'none';
  isComment?: boolean;
}

// Returns a patch for the given finding, or undefined if no template exists.
export function buildPatch(finding: Finding): PatchResult | undefined {
  switch (finding.ruleId) {
    case 'perf-lens.noexcept.move-ops':    return patchNoexceptMoveOps(finding);
    case 'perf-lens.constexpr.promotion-variable': return patchConstexprPromotion(finding);
    case 'perf-lens.stl.endl-in-hot':       return patchEndlFlush(finding);
    case 'perf-lens.stl.range-for-copy':   return patchRangeForCopy(finding);
    case 'perf-lens.hotpath.vector-no-reserve': return patchVectorNoReserve(finding);
    case 'perf-lens.padding.detected':     return patchPaddingDetected(finding);
    case 'perf-lens.hotpath.std-function': return patchStdFunction(finding);
    case 'perf-lens.hotpath.virtual-dispatch': return patchVirtualDispatch(finding);
    case 'perf-lens.vec.aliasing':         return patchVecAliasing(finding);
    case 'perf-lens.concurrency.mutex-where-atomic': return patchMutexWhereAtomic(finding);
    case 'perf-lens.hotpath.allocation-in-loop':     return patchAllocationInLoop(finding);
    case 'perf-lens.nodiscard.error-return':         return patchNodiscardReturn(finding);
    case 'perf-lens.ub.signed-loop-bound':           return patchSignedLoopBound(finding);
    case 'perf-lens.vec.complex-cf':                 return patchComplexCf(finding);
    case 'perf-lens.vec.reduction-fp':               return patchReductionFp(finding);
    case 'perf-lens.padding.cache-line-straddle':    return patchCacheLineStraddle(finding);
    case 'perf-lens.constexpr.promotion-function':   return patchPromotionFunction(finding);
    case 'perf-lens.memory_layout.aos-to-soa':       return patchAosToSoa(finding);
    default: return undefined;
  }
}

export const SUPPORTED_RULE_IDS = new Set([
  'perf-lens.noexcept.move-ops',
  'perf-lens.constexpr.promotion-variable',
  'perf-lens.stl.endl-in-hot',
  'perf-lens.stl.range-for-copy',
  'perf-lens.hotpath.vector-no-reserve',
  'perf-lens.padding.detected',
  'perf-lens.hotpath.std-function',
  'perf-lens.hotpath.virtual-dispatch',
  'perf-lens.vec.aliasing',
  'perf-lens.concurrency.mutex-where-atomic',
  'perf-lens.hotpath.allocation-in-loop',
  'perf-lens.nodiscard.error-return',
  'perf-lens.ub.signed-loop-bound',
  'perf-lens.vec.complex-cf',
  'perf-lens.vec.reduction-fp',
  'perf-lens.padding.cache-line-straddle',
  'perf-lens.constexpr.promotion-function',
  'perf-lens.memory_layout.aos-to-soa',
]);

// ---------------------------------------------------------------------------
// noexcept.move-ops — add `noexcept` to move ctor/assignment declaration
// ---------------------------------------------------------------------------
function patchNoexceptMoveOps(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  // Insert `noexcept` before the opening brace or `= default`/`= delete`
  let patched = original;
  if (/\)\s*=\s*(default|delete)/.test(original)) {
    patched = original.replace(/\)\s*(=\s*(default|delete))/, ') noexcept $1');
  } else if (/\)\s*\{/.test(original)) {
    patched = original.replace(/\)\s*\{/, ') noexcept {');
  } else if (/\)\s*$/.test(original.trimEnd())) {
    patched = original.trimEnd() + ' noexcept';
  } else {
    return undefined;
  }

  const edit = new vscode.WorkspaceEdit();
  const uri  = vscode.Uri.file(finding.file);
  edit.replace(uri, lineRange(lineIdx), patched);
  return { edit, description: 'Add `noexcept` to move operation', verificationPredicate: 'none' };
}

// ---------------------------------------------------------------------------
// constexpr.promotion-variable — replace `const` with `constexpr`
// ---------------------------------------------------------------------------
function patchConstexprPromotion(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  if (!original.includes('const ')) return undefined;

  // Only replace first occurrence of `const ` (not `constexpr`)
  const patched = original.replace(/\bconst\b(?!\s*expr)/, 'constexpr');
  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: 'Promote `const` variable to `constexpr`', verificationPredicate: 'constexpr_eval' };
}

// ---------------------------------------------------------------------------
// stl.endl-flush — replace `<< std::endl` / `<< endl` with `<< '\n'`
// ---------------------------------------------------------------------------
function patchEndlFlush(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  let patched = original
    .replace(/<<\s*std::endl\b/g, "<< '\\n'")
    .replace(/<<\s*endl\b/g, "<< '\\n'");

  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: "Replace `std::endl` with `'\\n'` to avoid flush", verificationPredicate: 'no_endl_call' };
}

// ---------------------------------------------------------------------------
// stl.range-for-copy — add `const auto&` to range-for loop variable
// ---------------------------------------------------------------------------
function patchRangeForCopy(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  // Match `for (auto x :` or `for (T x :`
  const match = original.match(/(\bfor\s*\(\s*)(auto\b|(?:[\w:]+\b(?:\s*<[^>]+>)?\s*))(\s+\w+\s*:)/);
  if (!match) return undefined;

  // Don't re-patch already-correct code
  if (/for\s*\(\s*const\s/.test(original)) return undefined;

  const patched = original.replace(
    /(\bfor\s*\(\s*)(auto\b|(?:[\w:]+\b(?:\s*<[^>]+>)?\s*))(\s+\w+\s*:)/,
    (_all, forPart, typePart, rest) => `${forPart}const ${typePart.trimStart()}& ${rest.trimStart()}`,
  );
  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: 'Change range-for loop variable to `const auto&`', verificationPredicate: 'none' };
}

// ---------------------------------------------------------------------------
// hotpath.vector-no-reserve — insert `.reserve(n)` before the loop
// ---------------------------------------------------------------------------
function patchVectorNoReserve(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  // Look for the loop line (the finding points to the push_back call inside the loop)
  // Find the enclosing for/while loop by scanning backwards from the finding line.
  const searchFrom = Math.min(finding.line - 1, lines.length - 1);
  let loopLineIdx = -1;
  for (let i = searchFrom; i >= 0 && i >= searchFrom - 10; --i) {
    if (/\b(for|while)\s*\(/.test(lines[i])) { loopLineIdx = i; break; }
  }
  if (loopLineIdx < 0) return undefined;

  // Find the vector variable name from the push_back call site
  const callLine = lines[finding.line - 1] ?? '';
  const vecNameMatch = callLine.match(/\b(\w+)\s*\.\s*(push_back|emplace_back)\s*\(/);
  if (!vecNameMatch) return undefined;
  const vecName = vecNameMatch[1];

  // Determine indentation from the loop line
  const indent = lines[loopLineIdx].match(/^(\s*)/)?.[1] ?? '';
  const reserveLine = `${indent}${vecName}.reserve(/* estimated size */);`;

  const edit = new vscode.WorkspaceEdit();
  const uri  = vscode.Uri.file(finding.file);
  const insertPos = new vscode.Position(loopLineIdx, 0);
  edit.insert(uri, insertPos, reserveLine + '\n');
  return { edit, description: `Add \`${vecName}.reserve()\` before loop`, verificationPredicate: 'none' };
}

// ---------------------------------------------------------------------------
// padding.detected — insert a comment showing the suggested field order
// ---------------------------------------------------------------------------
function patchPaddingDetected(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Reorder fields largest-to-smallest to eliminate padding.`;

  const edit = new vscode.WorkspaceEdit();
  const uri  = vscode.Uri.file(finding.file);
  edit.insert(uri, new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert comment to guide struct field reorder', verificationPredicate: 'none' };
}

// ---------------------------------------------------------------------------
// hotpath.std-function — insert a TODO comment pointing to template alternatives
// ---------------------------------------------------------------------------
function patchStdFunction(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Replace std::function with a template parameter or function pointer.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to replace std::function', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// hotpath.virtual-dispatch — insert a TODO comment near the call site
// ---------------------------------------------------------------------------
function patchVirtualDispatch(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Virtual dispatch inside loop — consider CRTP, final class, or type-sorted batching.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to remove virtual dispatch from loop', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// vec.aliasing — add `__restrict__` to pointer parameters on the function line
// ---------------------------------------------------------------------------
function patchVecAliasing(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  // Add __restrict__ after each raw pointer type `T*` not already annotated.
  // Pattern: word chars + optional spaces + `*` followed by a space and identifier.
  const patched = original.replace(
    /(\w[\w:<>]*\s*\*(?!\s*__restrict__))\s+(\w)/g,
    '$1 __restrict__ $2',
  );
  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: 'Add `__restrict__` to pointer parameters', verificationPredicate: 'vectorisation_enabled' };
}

// ---------------------------------------------------------------------------
// concurrency.mutex-where-atomic — insert a TODO comment on the struct line
// ---------------------------------------------------------------------------
function patchMutexWhereAtomic(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Replace std::mutex + integral with std::atomic<T> for lock-free access.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to replace mutex with std::atomic', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// hotpath.allocation-in-loop — insert a comment recommending hoisting
// ---------------------------------------------------------------------------
function patchAllocationInLoop(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Hoist heap allocation outside this loop; reuse a pre-allocated buffer.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to hoist allocation out of loop', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// nodiscard.error-return — add [[nodiscard]] before the return type
// ---------------------------------------------------------------------------
function patchNodiscardReturn(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  if (original.includes('[[nodiscard]]')) return undefined;

  // Insert [[nodiscard]] before the return type at the start of the declaration.
  const patched = original.replace(/^(\s*)/, '$1[[nodiscard]] ');
  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: 'Add `[[nodiscard]]` to function declaration', verificationPredicate: 'none' };
}

// ---------------------------------------------------------------------------
// ub.signed-loop-bound — insert a comment recommending a cast
// ---------------------------------------------------------------------------
function patchSignedLoopBound(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Cast bound to signed: e.g. static_cast<int>(v.size()) to avoid signed/unsigned mismatch.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to fix signed/unsigned loop bound', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// vec.complex-cf — insert a comment suggesting predicated restructure
// ---------------------------------------------------------------------------
function patchComplexCf(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Early exit prevents vectorisation — consider restructuring with a predicated expression.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to restructure early exit for vectorisation', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// vec.reduction-fp — insert a comment suggesting -ffast-math
// ---------------------------------------------------------------------------
function patchReductionFp(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): FP reduction — add -ffast-math (or -fassociative-math) to enable SIMD vectorisation.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to enable FP reduction vectorisation', verificationPredicate: 'vectorisation_enabled', isComment: true };
}

// ---------------------------------------------------------------------------
// padding.cache-line-straddle — insert a comment recommending alignas or reorder
// ---------------------------------------------------------------------------
function patchCacheLineStraddle(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Field straddles a 64-byte cache line — add alignas(64) or reorder fields.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to align straddling field', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// constexpr.promotion-function — add `constexpr` keyword to function
// ---------------------------------------------------------------------------
function patchPromotionFunction(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const original = lines[lineIdx];
  if (original.includes('constexpr')) return undefined;

  // Insert `constexpr` before the return type (first non-whitespace token).
  const patched = original.replace(/^(\s*)(\S)/, '$1constexpr $2');
  if (patched === original) return undefined;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(vscode.Uri.file(finding.file), lineRange(lineIdx), patched);
  return { edit, description: 'Add `constexpr` to function', verificationPredicate: 'constexpr_eval' };
}

// ---------------------------------------------------------------------------
// memory_layout.aos-to-soa — insert a comment recommending SoA layout
// ---------------------------------------------------------------------------
function patchAosToSoa(finding: Finding): PatchResult | undefined {
  const lines = readLines(finding.file);
  if (!lines) return undefined;

  const lineIdx = finding.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return undefined;

  const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? '';
  const comment = `${indent}// TODO(perf-lens): Consider struct-of-vectors (SoA) layout for better SIMD utilisation.`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(vscode.Uri.file(finding.file), new vscode.Position(lineIdx, 0), comment + '\n');
  return { edit, description: 'Insert TODO to consider SoA layout', verificationPredicate: 'none', isComment: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLines(filePath: string): string[] | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

function lineRange(lineIdx: number): vscode.Range {
  return new vscode.Range(lineIdx, 0, lineIdx, Number.MAX_SAFE_INTEGER);
}

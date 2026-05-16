import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPatch, SUPPORTED_RULE_IDS } from './patchTemplates';
import type { Finding } from '../sidecar/protocol';
import { FindingCategory, ConfidenceLevel } from '../sidecar/protocol';

function tmpFile(content: string, ext = '.cpp'): string {
  const f = path.join(os.tmpdir(), `pl-patch-test-${Date.now()}${ext}`);
  fs.writeFileSync(f, content);
  return f;
}

function makeFinding(overrides: Partial<Finding> & { file: string; line: number }): Finding {
  return {
    ruleId:     'perf-lens.noexcept.move-ops',
    title:      'Test',
    message:    'Test message',
    column:     0,
    category:   FindingCategory.FunctionAttrib,
    confidence: ConfidenceLevel.High,
    buildId:    '',
    ...overrides,
  };
}

// Helper: extract the new text for a single-file edit
function editText(edit: import('vscode').WorkspaceEdit, uri: import('vscode').Uri): string {
  const entries = edit.get(uri);
  return entries[0]?.newText ?? '';
}

describe('patchTemplates — SUPPORTED_RULE_IDS', () => {
  it('includes all 6 supported rules', () => {
    expect(SUPPORTED_RULE_IDS.size).toBe(6);
    expect(SUPPORTED_RULE_IDS.has('perf-lens.noexcept.move-ops')).toBe(true);
    expect(SUPPORTED_RULE_IDS.has('perf-lens.padding.detected')).toBe(true);
  });

  it('returns undefined for unsupported rule', () => {
    const f = tmpFile('void f() {}');
    const finding = makeFinding({ file: f, line: 1, ruleId: 'perf-lens.unknown.rule' });
    expect(buildPatch(finding)).toBeUndefined();
    fs.unlinkSync(f);
  });
});

describe('patchTemplates — noexcept.move-ops', () => {
  it('inserts noexcept before opening brace', () => {
    const src = `struct S {\n    S(S&&) {}\n};\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.noexcept.move-ops' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    expect(result!.edit).toBeDefined();
    fs.unlinkSync(f);
  });

  it('inserts noexcept before = default', () => {
    const src = `struct S {\n    S(S&&) = default;\n};\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.noexcept.move-ops' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    fs.unlinkSync(f);
  });
});

describe('patchTemplates — constexpr.promotion-variable', () => {
  it('replaces const with constexpr', () => {
    const src = `void f() {\n    const int x = 42;\n}\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.constexpr.promotion-variable' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    // Check edit contains constexpr
    const vscode = require('vscode') as typeof import('vscode');
    const uri = vscode.Uri.file(f);
    const newText = editText(result!.edit, uri);
    expect(newText).toContain('constexpr');
    expect(newText).not.toMatch(/\bconst\b(?!\s*expr)/);
    fs.unlinkSync(f);
  });

  it('returns undefined when no const on line', () => {
    const src = `void f() {\n    int x = 42;\n}\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.constexpr.promotion-variable' });
    const result = buildPatch(finding);
    expect(result).toBeUndefined();
    fs.unlinkSync(f);
  });
});

describe('patchTemplates — stl.endl-flush', () => {
  it("replaces std::endl with '\\n'", () => {
    const src = `void f() {\n    std::cout << std::endl;\n}\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.stl.endl-flush' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    const vscode = require('vscode') as typeof import('vscode');
    const newText = editText(result!.edit, vscode.Uri.file(f));
    expect(newText).toContain("'\\n'");
    expect(newText).not.toContain('endl');
    fs.unlinkSync(f);
  });
});

describe('patchTemplates — stl.range-for-copy', () => {
  it('adds const auto& to range-for variable', () => {
    const src = `void f(const std::vector<std::string>& v) {\n    for (auto s : v) {}\n}\n`;
    const f = tmpFile(src);
    const finding = makeFinding({ file: f, line: 2, ruleId: 'perf-lens.stl.range-for-copy' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    const vscode = require('vscode') as typeof import('vscode');
    const newText = editText(result!.edit, vscode.Uri.file(f));
    expect(newText).toContain('const');
    expect(newText).toContain('&');
    fs.unlinkSync(f);
  });
});

describe('patchTemplates — hotpath.vector-no-reserve', () => {
  it('inserts reserve before the enclosing for loop', () => {
    const src = `std::vector<int> build(int n) {\n    std::vector<int> v;\n    for (int i = 0; i < n; ++i)\n        v.push_back(i);\n    return v;\n}\n`;
    const f = tmpFile(src);
    // Finding points to the push_back line (line 4)
    const finding = makeFinding({ file: f, line: 4, ruleId: 'perf-lens.hotpath.vector-no-reserve' });
    const result = buildPatch(finding);
    expect(result).toBeDefined();
    // The edit should insert a reserve() call
    const vscode = require('vscode') as typeof import('vscode');
    const entries = result!.edit.get(vscode.Uri.file(f));
    const newText = entries[0]?.newText ?? '';
    expect(newText).toContain('reserve');
    expect(newText).toContain('v.reserve');
    fs.unlinkSync(f);
  });
});

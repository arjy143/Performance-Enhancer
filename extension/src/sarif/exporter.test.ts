import { buildSarifLog } from './exporter';
import type { Finding, OptRemark } from '../sidecar/protocol';
import { FindingCategory, ConfidenceLevel, RemarkCategory } from '../sidecar/protocol';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId:     'perf-lens.hotpath.vector-no-reserve',
    title:      'Missing vector reserve',
    message:    'Call reserve() before the loop',
    file:       '/workspace/src/main.cpp',
    line:       42,
    column:     5,
    category:   FindingCategory.HotPath,
    confidence: ConfidenceLevel.Medium,
    buildId:    'test',
    ...overrides,
  };
}

function makeRemark(overrides: Partial<OptRemark> = {}): OptRemark {
  return {
    type:     1,   // Missed
    pass:     'loop-vectorize',
    name:     'not vectorized',
    file:     '/workspace/src/main.cpp',
    line:     10,
    column:   3,
    function: 'compute',
    message:  'loop not vectorised: aliasing',
    category: RemarkCategory.Vectorisation,
    isStale:  false,
    buildId:  'test',
    ...overrides,
  };
}

describe('buildSarifLog', () => {
  it('produces valid SARIF 2.1.0 JSON with correct schema field', () => {
    const sarif = JSON.parse(buildSarifLog([], [], {}));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0.json');
    expect(sarif.runs).toHaveLength(1);
  });

  it('includes finding as a result with correct ruleId', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding()], [], {}));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('perf-lens.hotpath.vector-no-reserve');
  });

  it('maps High confidence to level=error', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding({ confidence: ConfidenceLevel.High })], [], {}));
    expect(sarif.runs[0].results[0].level).toBe('error');
  });

  it('maps Medium confidence to level=warning', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding({ confidence: ConfidenceLevel.Medium })], [], {}));
    expect(sarif.runs[0].results[0].level).toBe('warning');
  });

  it('maps Low confidence to level=note', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding({ confidence: ConfidenceLevel.Low })], [], {}));
    expect(sarif.runs[0].results[0].level).toBe('note');
  });

  it('registers the rule in the tool driver', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding()], [], {}));
    const rules: Array<{ id: string }> = sarif.runs[0].tool.driver.rules;
    const rule = rules.find(r => r.id === 'perf-lens.hotpath.vector-no-reserve');
    expect(rule).toBeDefined();
    expect(rule!.id).toBe('perf-lens.hotpath.vector-no-reserve');
  });

  it('deduplicates rules when multiple findings share the same rule', () => {
    const findings = [makeFinding(), makeFinding({ line: 99 })];
    const sarif = JSON.parse(buildSarifLog(findings, [], {}));
    const rules: Array<{ id: string }> = sarif.runs[0].tool.driver.rules;
    const matching = rules.filter(r => r.id === 'perf-lens.hotpath.vector-no-reserve');
    expect(matching).toHaveLength(1);
  });

  it('includes compiler remarks when includeRemarks=true', () => {
    const sarif = JSON.parse(buildSarifLog([], [makeRemark()], { includeRemarks: true }));
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('perf-lens.remark.loop-vectorize');
  });

  it('excludes compiler remarks when includeRemarks=false', () => {
    const sarif = JSON.parse(buildSarifLog([], [makeRemark()], { includeRemarks: false }));
    expect(sarif.runs[0].results).toHaveLength(0);
  });

  it('makes file paths relative when workspaceRoot is set', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding()], [], { workspaceRoot: '/workspace' }));
    const uri: string = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('src/main.cpp');
    expect(uri).not.toContain('file://');
  });

  it('uses absolute file URI when workspaceRoot not set', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding()], [], {}));
    const uri: string = sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toContain('file://');
    expect(uri).toContain('/workspace/src/main.cpp');
  });

  it('converts rule ID to PascalCase name', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding()], [], {}));
    const rules: Array<{ id: string; name: string }> = sarif.runs[0].tool.driver.rules;
    const rule = rules.find(r => r.id === 'perf-lens.hotpath.vector-no-reserve');
    expect(rule!.name).toBe('HotpathVectorNoReserve');
  });

  it('sets correct line and column in location region', () => {
    const sarif = JSON.parse(buildSarifLog([makeFinding({ line: 42, column: 5 })], [], {}));
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(42);
    expect(region.startColumn).toBe(5);
  });

  it('handles empty findings and remarks', () => {
    const sarif = JSON.parse(buildSarifLog([], [], {}));
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });
});

import * as path from 'path';
import type { Finding, OptRemark } from '../sidecar/protocol';
import { FINDING_CATEGORY_LABELS, CONFIDENCE_LABELS, FindingCategory } from '../sidecar/protocol';

// SARIF 2.1.0 schema — https://docs.oasis-open.org/sarif/sarif/v2.1.0/
const SARIF_SCHEMA = 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';
const SARIF_VERSION = '2.1.0';

// Maps our FindingCategory to SARIF tags for better tool integration.
const CATEGORY_TAGS: Record<FindingCategory, string[]> = {
  [FindingCategory.MemoryLayout]:   ['performance', 'memory-layout'],
  [FindingCategory.Vectorisation]:  ['performance', 'vectorisation'],
  [FindingCategory.Constexpr]:      ['performance', 'constexpr'],
  [FindingCategory.HotPath]:        ['performance', 'hot-path'],
  [FindingCategory.FunctionAttrib]: ['performance', 'function-attributes'],
  [FindingCategory.StlHygiene]:     ['performance', 'stl-hygiene'],
  [FindingCategory.Concurrency]:    ['performance', 'concurrency'],
  [FindingCategory.UndefinedBeh]:   ['correctness', 'undefined-behaviour'],
  [FindingCategory.Build]:          ['build'],
  [FindingCategory.Other]:          ['performance'],
};

export interface SarifExportOptions {
  workspaceRoot?: string;
  includeRemarks?: boolean;
  toolVersion?: string;
}

// Produce a SARIF 2.1.0 log from a set of findings and optional remarks.
export function buildSarifLog(
  findings: Finding[],
  remarks: OptRemark[],
  opts: SarifExportOptions = {},
): string {
  const { workspaceRoot = '', includeRemarks = true, toolVersion = '0.6.0' } = opts;

  const rules = buildRuleIndex(findings, remarks, includeRemarks);
  const results = [
    ...findings.map(f => findingToResult(f, workspaceRoot)),
    ...(includeRemarks ? remarks.map(r => remarkToResult(r, workspaceRoot)) : []),
  ];

  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'Perf Lens',
            version: toolVersion,
            informationUri: 'https://github.com/arjun/perf-lens',
            rules: Object.values(rules),
          },
        },
        results,
        columnKind: 'utf16CodeUnits',
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  help?: { text: string };
  properties?: { tags?: string[]; confidence?: string };
}

function buildRuleIndex(
  findings: Finding[],
  remarks: OptRemark[],
  includeRemarks: boolean,
): Record<string, SarifRule> {
  const rules: Record<string, SarifRule> = {};

  for (const f of findings) {
    if (rules[f.ruleId]) continue;
    rules[f.ruleId] = {
      id: f.ruleId,
      name: ruleIdToName(f.ruleId),
      shortDescription: { text: f.title },
      properties: {
        tags: CATEGORY_TAGS[f.category] ?? ['performance'],
        confidence: CONFIDENCE_LABELS[f.confidence],
      },
    };
  }

  if (includeRemarks) {
    for (const r of remarks) {
      const ruleId = `perf-lens.remark.${r.pass}`;
      if (rules[ruleId]) continue;
      rules[ruleId] = {
        id: ruleId,
        name: r.pass,
        shortDescription: { text: `Compiler remark: ${r.pass}` },
        properties: { tags: ['performance', 'compiler-remark'] },
      };
    }
  }

  return rules;
}

function findingToResult(f: Finding, workspaceRoot: string): object {
  return {
    ruleId: f.ruleId,
    level: confidenceToLevel(f.confidence),
    message: { text: f.message },
    locations: [location(f.file, f.line, f.column, workspaceRoot)],
    properties: {
      category: FINDING_CATEGORY_LABELS[f.category],
      confidence: CONFIDENCE_LABELS[f.confidence],
    },
  };
}

function remarkToResult(r: OptRemark, workspaceRoot: string): object {
  const ruleId = `perf-lens.remark.${r.pass}`;
  return {
    ruleId,
    level: r.type === 0 ? 'note' : 'warning',  // 0 = Passed, 1 = Missed
    message: { text: r.message },
    locations: [location(r.file, r.line, r.column, workspaceRoot)],
  };
}

function location(file: string, line: number, column: number, workspaceRoot: string): object {
  const uri = fileUri(file, workspaceRoot);
  return {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: workspaceRoot ? 'SRCROOT' : undefined },
      region: {
        startLine: Math.max(1, line),
        startColumn: Math.max(1, column),
      },
    },
  };
}

function fileUri(filePath: string, workspaceRoot: string): string {
  if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) {
    return `file://${filePath}`;
  }
  // Make relative to workspace root so SARIF is portable
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

// Convert `perf-lens.hotpath.vector-no-reserve` → `HotpathVectorNoReserve`
function ruleIdToName(ruleId: string): string {
  return ruleId
    .split('.')
    .slice(1)                           // drop "perf-lens" prefix
    .flatMap(part => part.split('-'))
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

// SARIF levels: error / warning / note / none
function confidenceToLevel(confidence: number): string {
  if (confidence === 0) return 'error';    // High
  if (confidence === 1) return 'warning';  // Medium
  return 'note';                           // Low
}

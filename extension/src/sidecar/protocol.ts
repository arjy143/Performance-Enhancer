export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const RpcErrorCodes = {
  ParseError:     -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams:  -32602,
  InternalError:  -32603,
} as const;

// ping → pong
export interface PingResult { pong: true }

// echo
export interface EchoParams  { message: string }
export interface EchoResult  { message: string }

// ready notification (sidecar → extension)
export interface ReadyParams {
  version: string;
  pid: number;
  capabilities: string[];
}

// Compiler remarks (Phase 2)

export const RemarkType = { Passed: 0, Missed: 1, Analysis: 2 } as const;
export type RemarkType = typeof RemarkType[keyof typeof RemarkType];

export const RemarkCategory = {
  Vectorisation: 0,
  Inlining:      1,
  Unrolling:     2,
  LoopTransform: 3,
  Memory:        4,
  CodeLayout:    5,
  DeadCode:      6,
  Other:         7,
} as const;
export type RemarkCategory = typeof RemarkCategory[keyof typeof RemarkCategory];

export const CATEGORY_LABELS: Record<RemarkCategory, string> = {
  [RemarkCategory.Vectorisation]: 'Vectorisation',
  [RemarkCategory.Inlining]:      'Inlining',
  [RemarkCategory.Unrolling]:     'Unrolling',
  [RemarkCategory.LoopTransform]: 'Loop Transform',
  [RemarkCategory.Memory]:        'Memory',
  [RemarkCategory.CodeLayout]:    'Code Layout',
  [RemarkCategory.DeadCode]:      'Dead Code',
  [RemarkCategory.Other]:         'Other',
};

export interface OptRemark {
  type:     RemarkType;
  pass:     string;
  name:     string;
  file:     string;
  line:     number;
  column:   number;
  function: string;
  message:  string;
  category: RemarkCategory;
  isStale:  boolean;
  buildId:  string;
}

export interface IngestRemarksFileParams { path: string; buildId?: string }
export interface IngestRemarksFileResult { count: number; buildId: string }

export interface GetRemarksParams { file: string; line?: number }
// returns OptRemark[]

export interface RecompileWithRemarksParams { file: string }
export interface RecompileWithRemarksResult { remarksFile: string; count: number }

// returns string[]
export interface GetRemarkedFilesResult { files: string[] }

// Static analysis findings (Phase 3)

export const FindingCategory = {
  MemoryLayout:   0,
  Vectorisation:  1,
  Constexpr:      2,
  HotPath:        3,
  FunctionAttrib: 4,
  StlHygiene:     5,
  Concurrency:    6,
  UndefinedBeh:   7,
  Build:          8,
  Other:          9,
} as const;
export type FindingCategory = typeof FindingCategory[keyof typeof FindingCategory];

export const ConfidenceLevel = { High: 0, Medium: 1, Low: 2 } as const;
export type ConfidenceLevel = typeof ConfidenceLevel[keyof typeof ConfidenceLevel];

export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  [FindingCategory.MemoryLayout]:   'Memory Layout',
  [FindingCategory.Vectorisation]:  'Vectorisation',
  [FindingCategory.Constexpr]:      'Constexpr',
  [FindingCategory.HotPath]:        'Hot Path',
  [FindingCategory.FunctionAttrib]: 'Function Attributes',
  [FindingCategory.StlHygiene]:     'STL Hygiene',
  [FindingCategory.Concurrency]:    'Concurrency',
  [FindingCategory.UndefinedBeh]:   'Undefined Behaviour',
  [FindingCategory.Build]:          'Build',
  [FindingCategory.Other]:          'Other',
};

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  [ConfidenceLevel.High]:   'high',
  [ConfidenceLevel.Medium]: 'medium',
  [ConfidenceLevel.Low]:    'low',
};

export interface Finding {
  ruleId:     string;
  title:      string;
  message:    string;
  file:       string;
  line:       number;
  column:     number;
  category:   FindingCategory;
  confidence: ConfidenceLevel;
  buildId:    string;
}

export interface AnalyseFileParams { file: string; buildId?: string }
export interface AnalyseFileResult { count: number; buildId: string }

export interface GetFindingsParams { file: string; line?: number }
// returns Finding[]

// Godbolt-Lite (Phase 5)

export interface SourceMapping {
  asmLineStart:  number;
  asmLineEnd:    number;
  sourceLine:    number;
  sourceColumn:  number;
  sourceFile:    string;
  inlineDepth:   number;
}

export interface AssemblyOutput {
  text:            string;
  sourceMap:       SourceMapping[];
  vectorWidthUsed: number;  // 1=scalar 4=xmm 8=ymm 16=zmm
}

export interface CompileDiagnostic {
  line:    number;
  column:  number;
  level:   'error' | 'warning' | 'note';
  message: string;
}

export interface MCAReport {
  ipc:                 number;
  cyclesPerIteration:  number;
  bottleneck:          string;
}

export interface CompileResult {
  success:     boolean;
  assembly:    AssemblyOutput;
  diagnostics: CompileDiagnostic[];
  mca?:        MCAReport;
  contentHash: string;
  fromCache:   boolean;
  wallTimeMs:  number;
  stderr:      string;
}

export type InstructionDiffKind = 'added' | 'removed' | 'unchanged';

export interface InstructionDiff {
  kind:        InstructionDiffKind;
  beforeText:  string;
  afterText:   string;
  category:    string;  // "vectorised" | "eliminated" | ""
}

export interface AsmDiff {
  changes:               InstructionDiff[];
  instructionsBefore:    number;
  instructionsAfter:     number;
  vectorWidthBefore:     number;
  vectorWidthAfter:      number;
  vectorisationImproved: boolean;
  summary:               string;
}

export interface CompileSnippetParams {
  source: string;
  flags?: string[];
  runMca?: boolean;
}

export interface DiffAsmParams {
  beforeText:         string;
  afterText:          string;
  vectorWidthBefore?: number;
  vectorWidthAfter?:  number;
}

// Profile Integration (Phase 6)

export interface ProfileMetadata {
  id:              string;
  label:           string;
  recordedAt:      number;   // Unix seconds
  durationMs:      number;
  binaryPath:      string;
  binaryBuildId:   string;
  cpuModel:        string;
  samplingFreqHz:  number;
  sourceProfiler:  string;   // "perf" | "pprof" | etc.
  totalSamples:    number;
}

export interface LineHotness {
  file:       string;
  line:       number;
  eventType:  string;
  selfCount:  number;
  totalCount: number;
  fraction:   number;   // selfCount / totalCount ∈ [0, 1]
}

export interface FunctionHotness {
  function:   string;
  eventType:  string;
  selfCount:  number;
  totalCount: number;
  fraction:   number;
}

export interface ImportProfileParams  { file: string; label?: string }
export interface ImportProfileResult  { profileId: string; totalSamples: number }

export interface GetLineHotnessParams  { profileId: string; file: string; line: number; event?: string }
export interface GetFileHotnessParams  { profileId: string; file: string; event?: string }
export interface GetTopFunctionsParams { profileId: string; n?: number; event?: string }
export interface DeleteProfileParams   { profileId: string }

export function isRpcResponse(msg: unknown): msg is RpcResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m['jsonrpc'] === '2.0' && 'id' in m;
}

export function isRpcNotification(msg: unknown): msg is RpcNotification {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m['jsonrpc'] === '2.0' && 'method' in m && !('id' in m);
}

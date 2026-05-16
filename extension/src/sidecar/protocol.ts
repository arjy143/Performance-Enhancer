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

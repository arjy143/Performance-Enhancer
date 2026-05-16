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

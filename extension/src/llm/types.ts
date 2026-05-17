export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  temperature: number;
  maxTokens: number;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json';
}

export type StreamChunkType = 'text' | 'done' | 'error';

export interface StreamChunk {
  type: StreamChunkType;
  content?: string;
}

export type ModelClass = 'small' | 'mid' | 'frontier';
export type Health = 'healthy' | 'degraded' | 'unavailable';

export interface ProviderCapabilities {
  contextWindowTokens: number;
  outputTokenLimit: number;
  supportsStreaming: boolean;
  modelClass: ModelClass;
  isLocal: boolean;
  costPerInputToken?: number;   // USD per token
  costPerOutputToken?: number;
}

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  health: Health;
  complete(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
  healthCheck(): Promise<Health>;
}

export type TaskKind =
  | 'translate_opt_remark'
  | 'explain_finding'
  | 'explain_hotness'
  | 'classify_opt_remark_cause'
  | 'synthesise_top_findings'
  | 'suggest_novel_refactor';

export interface TaskDefinition {
  kind: TaskKind;
  minimumModelClass: ModelClass;
  expectedOutputTokens: number;
  responseFormat: 'text' | 'json';
  defaultTemperature: number;
  cacheable: boolean;
  costSensitivity: 'low' | 'medium' | 'high';
}

export interface CacheKey {
  task: TaskKind;
  contextHash: string;
  modelId: string;
  promptVersion: string;
}

export interface RouterContext {
  allowRemote: boolean;
  budgetRemainingUSD?: number;
}

export type TaskResultType = 'success' | 'silent_degrade';

export interface TaskResult {
  type: TaskResultType;
  stream?: AsyncIterable<StreamChunk>;
  reason?: string;
}

export interface ProviderConfig {
  id: string;
  type: 'ollama' | 'openai-compat' | 'anthropic' | 'openai' | 'mock';
  baseUrl?: string;
  apiKey?: string;
  model: string;
  priority?: number;
  isLocal?: boolean;
}

// Context objects passed to prompt builders
export interface RemarkContext {
  pass: string;
  name: string;
  message: string;
  func: string;
  snippet: string;
  compiler: string;
  optLevel: string;
}

export interface FindingContext {
  ruleId: string;
  title: string;
  snippet: string;
  optRemark?: string;
  hotness?: number;
}

export interface HotnessContext {
  topFunctions: Array<{
    function: string;
    pct: number;
    eventType: string;
  }>;
  profileLabel:      string;
  totalSamples:      number;
  activeFindings:    Array<{ ruleId: string; title: string; file: string; line: number }>;
}

export interface SynthesisContext extends HotnessContext {
  cpuModel?: string;
}

export interface RefactorContext {
  ruleId: string;
  title: string;
  snippet: string;
  file: string;
  line: number;
  hotness?: number;
  findings: Array<{ ruleId: string; title: string; line: number }>;
}

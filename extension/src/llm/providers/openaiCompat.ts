import type {
  LLMProvider, ProviderCapabilities, CompletionRequest, StreamChunk, Health,
} from '../types';

interface SseDelta {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  error?: { message?: string };
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  health: Health = 'healthy';

  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly _baseUrl: string,
    private readonly _model: string,
    private readonly _apiKey: string,
    opts: {
      modelClass?: ProviderCapabilities['modelClass'];
      isLocal?: boolean;
      displayName?: string;
      costPerInputToken?: number;
      costPerOutputToken?: number;
    } = {},
  ) {
    this.id = `openai-compat:${_model}@${_baseUrl}`;
    this.displayName = opts.displayName ?? `OpenAI-compat — ${_model}`;
    this.capabilities = {
      contextWindowTokens: 128_000,
      outputTokenLimit: 4096,
      supportsStreaming: true,
      modelClass: opts.modelClass ?? 'mid',
      isLocal: opts.isLocal ?? false,
      costPerInputToken: opts.costPerInputToken,
      costPerOutputToken: opts.costPerOutputToken,
    };
  }

  async* complete(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const messages = [
      { role: 'system', content: req.system },
      ...req.messages.map(m => ({ role: m.role, content: m.content })),
    ];

    let resp: Response;
    try {
      resp = await fetch(`${this._baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify({
          model: this._model,
          messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
          ...(req.responseFormat === 'json'
            ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
      });
    } catch (err) {
      this.health = 'unavailable';
      throw err;
    }

    if (!resp.ok) {
      this.health = 'degraded';
      throw new Error(`OpenAI HTTP ${resp.status}`);
    }

    yield* parseSseStream(resp, signal);
    this.health = 'healthy';
  }

  async healthCheck(): Promise<Health> {
    try {
      const resp = await fetch(`${this._baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this._apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      this.health = resp.ok ? 'healthy' : 'degraded';
    } catch {
      this.health = 'unavailable';
    }
    return this.health;
  }
}

async function* parseSseStream(
  resp: Response,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { yield { type: 'done' }; return; }
          let parsed: SseDelta;
          try { parsed = JSON.parse(data) as SseDelta; } catch { continue; }
          if (parsed.error?.message) throw new Error(parsed.error.message);
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield { type: 'text', content: text };
          if (parsed.choices?.[0]?.finish_reason) { yield { type: 'done' }; return; }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: 'done' };
}

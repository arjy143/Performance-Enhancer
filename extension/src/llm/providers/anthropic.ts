import type {
  LLMProvider, ProviderCapabilities, CompletionRequest, StreamChunk, Health,
} from '../types';

const BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  health: Health = 'healthy';

  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly _model: string,
    private readonly _apiKey: string,
    opts: {
      modelClass?: ProviderCapabilities['modelClass'];
      costPerInputToken?: number;
      costPerOutputToken?: number;
    } = {},
  ) {
    this.id = `anthropic:${_model}`;
    this.displayName = `Anthropic — ${_model}`;
    this.capabilities = {
      contextWindowTokens: 200_000,
      outputTokenLimit: 8192,
      supportsStreaming: true,
      modelClass: opts.modelClass ?? 'frontier',
      isLocal: false,
      costPerInputToken: opts.costPerInputToken,
      costPerOutputToken: opts.costPerOutputToken,
    };
  }

  async* complete(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let resp: Response;
    try {
      resp = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this._apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this._model,
          system: req.system,
          messages: req.messages.map(m => ({ role: m.role, content: m.content })),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        }),
        signal,
      });
    } catch (err) {
      this.health = 'unavailable';
      throw err;
    }

    if (!resp.ok) {
      this.health = 'degraded';
      throw new Error(`Anthropic HTTP ${resp.status}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body from Anthropic');
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
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('data:')) eventData = line.slice(5).trim();
          }
          if (!eventData) continue;
          let ev: AnthropicEvent;
          try { ev = JSON.parse(eventData) as AnthropicEvent; } catch { continue; }
          if (ev.type === 'error') throw new Error(ev.error?.message ?? 'Anthropic stream error');
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const text = ev.delta.text;
            if (text) yield { type: 'text', content: text };
          }
          if (ev.type === 'message_stop') { yield { type: 'done' }; return; }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { type: 'done' };
    this.health = 'healthy';
  }

  async healthCheck(): Promise<Health> {
    // Anthropic has no lightweight ping endpoint; do a minimal models list call.
    try {
      const resp = await fetch(`${BASE_URL}/v1/models`, {
        headers: { 'x-api-key': this._apiKey, 'anthropic-version': API_VERSION },
        signal: AbortSignal.timeout(5000),
      });
      this.health = resp.ok ? 'healthy' : 'degraded';
    } catch {
      this.health = 'unavailable';
    }
    return this.health;
  }
}

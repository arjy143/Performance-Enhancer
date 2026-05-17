import type {
  LLMProvider, ProviderCapabilities, CompletionRequest, StreamChunk, Health,
} from '../types';

interface OllamaChunk {
  message?: { content?: string };
  done: boolean;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  health: Health = 'healthy';

  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly _baseUrl: string,
    private readonly _model: string,
    modelClass: ProviderCapabilities['modelClass'] = 'small',
  ) {
    this.id = `ollama:${_model}`;
    this.displayName = `Ollama (${_model})`;
    this.capabilities = {
      contextWindowTokens: 8192,
      outputTokenLimit: 2048,
      supportsStreaming: true,
      modelClass,
      isLocal: true,
    };
  }

  async* complete(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const messages = [
      { role: 'system', content: req.system },
      ...req.messages.map(m => ({ role: m.role, content: m.content })),
    ];

    let resp: Response;
    try {
      resp = await fetch(`${this._baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this._model,
          messages,
          stream: true,
          options: { temperature: req.temperature, num_predict: req.maxTokens },
        }),
        signal,
      });
    } catch (err) {
      this.health = 'unavailable';
      throw err;
    }

    if (!resp.ok) {
      this.health = 'degraded';
      throw new Error(`Ollama HTTP ${resp.status}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let chunk: OllamaChunk;
          try { chunk = JSON.parse(trimmed) as OllamaChunk; } catch { continue; }
          if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
          const text = chunk.message?.content;
          if (text) yield { type: 'text', content: text };
          if (chunk.done) { yield { type: 'done' }; return; }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { type: 'done' };
  }

  async healthCheck(): Promise<Health> {
    try {
      const resp = await fetch(`${this._baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      this.health = resp.ok ? 'healthy' : 'degraded';
    } catch {
      this.health = 'unavailable';
    }
    return this.health;
  }
}

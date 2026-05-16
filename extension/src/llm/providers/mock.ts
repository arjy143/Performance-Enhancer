import type {
  LLMProvider, ProviderCapabilities, CompletionRequest, StreamChunk, Health,
} from '../types';

export class MockLLMProvider implements LLMProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock (test)';
  health: Health = 'healthy';

  readonly capabilities: ProviderCapabilities = {
    contextWindowTokens: 8192,
    outputTokenLimit: 1024,
    supportsStreaming: true,
    modelClass: 'small',
    isLocal: true,
  };

  // Customise per-test via this property.
  response = 'Mock LLM response.';
  shouldFail = false;

  async* complete(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    if (this.shouldFail) throw new Error('Mock provider failure');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const words = this.response.split(' ');
    for (const word of words) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      yield { type: 'text', content: word + ' ' };
    }
    yield { type: 'done' };
    void req; // suppress unused-param lint
  }

  async healthCheck(): Promise<Health> {
    return this.shouldFail ? 'unavailable' : 'healthy';
  }
}

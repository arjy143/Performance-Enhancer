import { TaskRouter } from './router';
import type { LLMProvider, ProviderCapabilities, Health } from './types';

function makeProvider(overrides: {
  id?: string;
  modelClass?: ProviderCapabilities['modelClass'];
  isLocal?: boolean;
  health?: Health;
}): LLMProvider {
  return {
    id: overrides.id ?? 'mock:model',
    displayName: 'Mock',
    health: overrides.health ?? 'healthy',
    capabilities: {
      contextWindowTokens: 8192,
      outputTokenLimit: 1024,
      supportsStreaming: true,
      modelClass: overrides.modelClass ?? 'small',
      isLocal: overrides.isLocal ?? true,
    },
    async* complete() { yield { type: 'done' as const }; },
    async healthCheck() { return this.health; },
  };
}

const localCtx  = { allowRemote: false };
const remoteCtx = { allowRemote: true };

describe('TaskRouter.selectProvider', () => {
  it('returns undefined when no providers', () => {
    const router = new TaskRouter([]);
    expect(router.selectProvider('translate_opt_remark', localCtx)).toBeUndefined();
  });

  it('returns the only healthy provider', () => {
    const p = makeProvider({ id: 'ollama:7b' });
    const router = new TaskRouter([p]);
    expect(router.selectProvider('translate_opt_remark', localCtx)?.id).toBe('ollama:7b');
  });

  it('skips unavailable providers', () => {
    const down = makeProvider({ id: 'down', health: 'unavailable' });
    const up   = makeProvider({ id: 'up',   health: 'healthy' });
    const router = new TaskRouter([down, up]);
    expect(router.selectProvider('translate_opt_remark', localCtx)?.id).toBe('up');
  });

  it('prefers local over remote', () => {
    const remote = makeProvider({ id: 'remote', isLocal: false });
    const local  = makeProvider({ id: 'local',  isLocal: true });
    const router = new TaskRouter([remote, local]);
    expect(router.selectProvider('translate_opt_remark', remoteCtx)?.id).toBe('local');
  });

  it('rejects remote providers when allowRemote=false', () => {
    const remote = makeProvider({ id: 'remote', isLocal: false });
    const router = new TaskRouter([remote]);
    expect(router.selectProvider('translate_opt_remark', localCtx)).toBeUndefined();
  });

  it('enforces minimum model class', () => {
    const small    = makeProvider({ id: 'small',    modelClass: 'small' });
    const frontier = makeProvider({ id: 'frontier', modelClass: 'frontier' });
    const router = new TaskRouter([small, frontier]);
    // suggest_novel_refactor requires 'frontier'
    expect(router.selectProvider('suggest_novel_refactor', remoteCtx)?.id).toBe('frontier');
  });
});

describe('TaskRouter.getProviderChain', () => {
  it('returns healthy providers first', () => {
    const degraded = makeProvider({ id: 'degraded', health: 'degraded' });
    const healthy  = makeProvider({ id: 'healthy',  health: 'healthy' });
    const router = new TaskRouter([degraded, healthy]);
    const chain = router.getProviderChain('translate_opt_remark', localCtx);
    expect(chain[0].id).toBe('healthy');
  });

  it('returns empty array when no providers match', () => {
    const small = makeProvider({ id: 'small', modelClass: 'small', isLocal: true });
    const router = new TaskRouter([small]);
    const chain = router.getProviderChain('suggest_novel_refactor', localCtx);
    expect(chain).toHaveLength(0);
  });
});

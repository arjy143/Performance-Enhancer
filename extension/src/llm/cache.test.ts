import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { LLMCache } from './cache';
import type { CacheKey } from './types';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `perf-lens-cache-test-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeKey(overrides: Partial<CacheKey> = {}): CacheKey {
  return {
    task: 'translate_opt_remark',
    contextHash: 'abc123',
    modelId: 'ollama:qwen2.5-coder:7b',
    promptVersion: '1',
    ...overrides,
  };
}

describe('LLMCache', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns undefined for missing key', () => {
    const cache = new LLMCache(dir);
    expect(cache.get(makeKey())).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const cache = new LLMCache(dir);
    const key = makeKey();
    cache.set(key, 'hello world');
    expect(cache.get(key)).toBe('hello world');
  });

  it('different keys return different values', () => {
    const cache = new LLMCache(dir);
    cache.set(makeKey({ contextHash: 'aaa' }), 'result-a');
    cache.set(makeKey({ contextHash: 'bbb' }), 'result-b');
    expect(cache.get(makeKey({ contextHash: 'aaa' }))).toBe('result-a');
    expect(cache.get(makeKey({ contextHash: 'bbb' }))).toBe('result-b');
  });

  it('overwrites existing key', () => {
    const cache = new LLMCache(dir);
    const key = makeKey();
    cache.set(key, 'first');
    cache.set(key, 'second');
    expect(cache.get(key)).toBe('second');
  });

  it('persists and reloads entries', async () => {
    const cache = new LLMCache(dir);
    const key = makeKey({ contextHash: 'persist-test' });
    cache.set(key, 'persisted value');
    await cache.persist();

    const cache2 = new LLMCache(dir);
    expect(cache2.get(key)).toBe('persisted value');
  });

  it('clear() removes all entries', () => {
    const cache = new LLMCache(dir);
    cache.set(makeKey({ contextHash: 'x' }), 'value');
    cache.clear();
    expect(cache.get(makeKey({ contextHash: 'x' }))).toBeUndefined();
  });

  it('survives a corrupt cache file', () => {
    fs.writeFileSync(path.join(dir, 'llm-cache.json'), 'not json{{{');
    expect(() => new LLMCache(dir)).not.toThrow();
  });
});

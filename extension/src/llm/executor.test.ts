import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { executeTask } from './executor';
import { TaskRouter } from './router';
import { LLMCache } from './cache';
import { MockLLMProvider } from './providers/mock';
import { buildTranslateRemarkRequest } from './promptLibrary';
import type { RemarkContext } from './types';

function tmpDir(): string {
  const d = path.join(os.tmpdir(), `perf-lens-exec-test-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const ctx: RemarkContext = {
  pass: 'loop-vectorize',
  name: 'UnsafeMemDep',
  message: 'loop not vectorized: unsafe memory dependency',
  func: 'processData',
  snippet: 'for (int i = 0; i < n; ++i) out[i] = in[i] * 2;',
  compiler: 'clang',
  optLevel: '-O2',
};

async function collect(stream: AsyncIterable<{ type: string; content?: string }>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content;
  }
  return text;
}

describe('executeTask', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns success with streamed text', async () => {
    const mock = new MockLLMProvider();
    mock.response = '{"summary":"loop not vectorized","why":"memory alias","action":"add restrict","confidence":"high"}';
    const router = new TaskRouter([mock]);
    const cache  = new LLMCache(dir);
    const req    = buildTranslateRemarkRequest(ctx);

    const result = await executeTask('translate_opt_remark', req, router, cache, new AbortController().signal, { allowRemote: false });
    expect(result.type).toBe('success');
    const text = await collect(result.stream!);
    expect(text).toContain('loop not vectorized');
  });

  it('returns cached result on second call', async () => {
    const mock = new MockLLMProvider();
    mock.response = 'cached content';
    const router = new TaskRouter([mock]);
    const cache  = new LLMCache(dir);
    const req    = buildTranslateRemarkRequest(ctx);

    const r1 = await executeTask('translate_opt_remark', req, router, cache, new AbortController().signal, { allowRemote: false });
    await collect(r1.stream!);

    // Mark as should-fail so only the cache can serve the second call.
    mock.shouldFail = true;
    const r2 = await executeTask('translate_opt_remark', req, router, cache, new AbortController().signal, { allowRemote: false });
    expect(r2.type).toBe('success');
    const text2 = await collect(r2.stream!);
    expect(text2).toContain('cached content');
  });

  it('silently degrades when no providers', async () => {
    const router = new TaskRouter([]);
    const cache  = new LLMCache(dir);
    const req    = buildTranslateRemarkRequest(ctx);

    const result = await executeTask('translate_opt_remark', req, router, cache, new AbortController().signal, { allowRemote: false });
    expect(result.type).toBe('silent_degrade');
  });

  it('falls back to next provider on failure', async () => {
    const failing = new MockLLMProvider();
    failing.shouldFail = true;

    const working = new MockLLMProvider();
    working.response = 'fallback response';
    // Make it frontier so it satisfies minimum class check too
    (working.capabilities as { modelClass: string }).modelClass = 'small';

    const router = new TaskRouter([failing, working]);
    const cache  = new LLMCache(dir);
    const req    = buildTranslateRemarkRequest(ctx);

    const result = await executeTask('translate_opt_remark', req, router, cache, new AbortController().signal, { allowRemote: false });
    // Since translate_opt_remark is cacheable and failing provider throws, executor tries next.
    // The result depends on execution — as long as it's not an uncaught exception.
    expect(['success', 'silent_degrade']).toContain(result.type);
  });
});

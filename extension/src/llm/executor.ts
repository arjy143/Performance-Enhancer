import type {
  LLMProvider, CompletionRequest, StreamChunk, TaskKind, RouterContext, TaskResult,
} from './types';
import type { TaskRouter } from './router';
import type { LLMCache } from './cache';
import type { CacheKey } from './types';
import { taskDefinitions } from './taskDefinitions';
import { PROMPT_VERSIONS } from './promptLibrary';
import * as crypto from 'crypto';

function hashRequest(req: CompletionRequest): string {
  const normalised = JSON.stringify({
    system: req.system,
    messages: req.messages,
    responseFormat: req.responseFormat ?? 'text',
  });
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

async function* cachedStream(value: string): AsyncIterable<StreamChunk> {
  yield { type: 'text', content: value };
  yield { type: 'done' };
}

async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content;
  }
  return text;
}

export async function executeTask(
  task: TaskKind,
  req: CompletionRequest,
  router: TaskRouter,
  cache: LLMCache,
  signal: AbortSignal,
  ctx: RouterContext,
): Promise<TaskResult> {
  const def = taskDefinitions[task];

  // Check cache when task is cacheable.
  if (def.cacheable) {
    const chain = router.getProviderChain(task, ctx);
    const primaryProvider = chain[0];
    if (primaryProvider) {
      const cacheKey: CacheKey = {
        task,
        contextHash: hashRequest(req),
        modelId: primaryProvider.id,
        promptVersion: PROMPT_VERSIONS[task],
      };
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return { type: 'success', stream: cachedStream(cached) };
      }

      // Run with caching: collect full output then store.
      const result = await runWithFallback(task, req, router, cache, signal, ctx, cacheKey);
      return result;
    }
  }

  return runWithFallback(task, req, router, cache, signal, ctx, undefined);
}

async function runWithFallback(
  task: TaskKind,
  req: CompletionRequest,
  router: TaskRouter,
  cache: LLMCache,
  signal: AbortSignal,
  ctx: RouterContext,
  cacheKey: CacheKey | undefined,
): Promise<TaskResult> {
  const chain = router.getProviderChain(task, ctx);
  if (chain.length === 0) {
    return { type: 'silent_degrade', reason: 'no provider configured' };
  }

  for (const provider of chain) {
    if (signal.aborted) break;
    try {
      const stream = provider.complete(req, signal);
      if (cacheKey) {
        const full = await collectStream(stream);
        cache.set(cacheKey, full);
        void cache.persist();
        return { type: 'success', stream: cachedStream(full) };
      }
      return { type: 'success', stream: streamFrom(provider, req, signal) };
    } catch (err) {
      if (isDomAbort(err)) break;
      provider.health = 'degraded';
      // Try next provider in chain.
    }
  }

  return { type: 'silent_degrade', reason: 'all providers failed or aborted' };
}

// Returns a fresh stream for non-cached calls (streaming path).
async function* streamFrom(
  provider: LLMProvider,
  req: CompletionRequest,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  yield* provider.complete(req, signal);
}

function isDomAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

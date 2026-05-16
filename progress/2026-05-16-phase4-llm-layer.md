# Phase 4 — LLM Layer: Session Progress

## Status: COMPLETE (30/30 TypeScript tests pass, 0 type errors)

## What was built

### TypeScript extension — LLM core (`extension/src/llm/`)

**Types (`types.ts`):**
- `LLMProvider` interface: `id`, `displayName`, `capabilities`, `health`, `complete(req, signal)`, `healthCheck()`
- `ProviderCapabilities`: `modelClass` ('small'|'mid'|'frontier'), `isLocal`, cost fields
- `CompletionRequest`, `StreamChunk`, `Message`
- `TaskKind` union (6 tasks), `TaskDefinition`, `CacheKey`, `RouterContext`, `TaskResult`
- `ProviderConfig`, `RemarkContext`, `FindingContext`

**Task definitions (`taskDefinitions.ts`):**
- Per-task routing config: min model class, expected tokens, cacheable, cost sensitivity
- Phase-4 tasks: `translate_opt_remark` (small, cacheable), `explain_finding` (small, cacheable), `explain_hotness` (stub), plus stubs for future tasks

**Prompt library (`promptLibrary.ts`):**
- `PROMPT_VERSIONS` — bump to invalidate cache
- `buildTranslateRemarkRequest(ctx: RemarkContext)` — JSON-output prompt, 300 tokens max
- `buildExplainFindingRequest(ctx: FindingContext)` — 4-paragraph prose prompt, 500 tokens max
- `buildExplainHotnessRequest(funcName, hotnessPct)` — stub for Phase 6

**Cache (`cache.ts`):**
- `LLMCache`: in-memory LRU (1000 entries) backed by `~/.vscode/.../llm-cache.json`
- SHA-256 key of `{task, contextHash, modelId, promptVersion}`
- `get`, `set`, `persist()` (async, non-fatal), `clear()`
- LRU eviction: Map insertion-order, oldest evicted first
- Survives corrupt JSON files gracefully

**Router (`router.ts`):**
- `TaskRouter.selectProvider(task, ctx)`: filters by health, model class, local/remote, budget
- `TaskRouter.getProviderChain(task, ctx)`: ordered list for fallback — healthy first, local first, smallest-sufficient model
- Local-first default: remote providers only used when `allowRemote=true`

**Executor (`executor.ts`):**
- `executeTask(task, req, router, cache, signal, ctx)`: checks cache → runs chain → stores result → returns `TaskResult`
- Cacheable tasks: collect full stream, cache, replay from cache
- Non-cacheable tasks: pass live stream through
- On provider failure: marks degraded, tries next in chain
- AbortError breaks chain immediately
- Silent degrade: `{ type: 'silent_degrade', reason }` when all providers fail

### Provider adapters (`extension/src/llm/providers/`)

| Adapter | Protocol | Details |
|---|---|---|
| `ollama.ts` | NDJSON streaming | `POST /api/chat`, line-by-line JSON, health via `/api/tags` |
| `openaiCompat.ts` | SSE streaming | `POST /v1/chat/completions`, `data:` lines split on `\n\n`, covers llama.cpp/LM Studio/vLLM/OpenAI/OpenRouter |
| `anthropic.ts` | SSE streaming | Anthropic `content_block_delta` events, `anthropic-version` header |
| `mock.ts` | In-memory | `response` and `shouldFail` properties; yields words one-by-one for streaming tests |

### ExplanationPanel (`extension/src/panels/explanationPanel.ts`)

- Singleton `WebviewPanel` in `ViewColumn.Beside`
- Reuses panel across calls (title updated, content reset)
- `streamResult(stream, signal)`: pumps chunks via `postMessage({ type: 'token', text })`
- `showDegrade(reason)`: shows warning message
- HTML: VS Code CSS variables, blinking cursor, pre-wrap output div
- CSP: `script-src 'unsafe-inline'` only (no external resources)

### Integration

**`extension/src/extension.ts` (v0.3.0):**
- `LLMManager` initialised with `ctx.globalStorageUri`
- `_initLLMProviders`: reads `perfLens.llm.primary` (ollama: shorthand) + `perfLens.llm.providers` array + auto-detects Ollama fallback
- Three new commands: `perfLens.translateRemark`, `perfLens.explainFinding`, `perfLens.clearLLMCache`
- Commands open `ExplanationPanel` and stream results; degrade gracefully if no providers

**Hover command links:**
- `hover.ts`: `remarkToMarkdown` appends `[$(sparkle) Translate with AI](command:perfLens.translateRemark?<json>)`
- `findingsProvider.ts`: `findingToMarkdown` appends `[$(sparkle) Explain with AI](command:perfLens.explainFinding?<json>)`
- Both use `md.isTrusted = true` to allow command URIs

**`package.json` (v0.3.0):**
- Three new commands: `translateRemark`, `explainFinding`, `clearLLMCache`
- New settings: `perfLens.llm.providers` (array), `perfLens.llm.allowRemote`, `perfLens.llm.budgetUSD`, `perfLens.llm.warnAtPercent`

**`__mocks__/vscode.ts`:**
- Added `window.createWebviewPanel` (jest mock)
- Added `workspace.onDidSaveTextDocument` (jest mock)
- Added `workspace.getConfiguration` (returns mock with `get` → defaultVal)
- Added `ViewColumn` enum

### Tests (`extension/src/llm/*.test.ts`)

- `cache.test.ts` — 7 tests: missing key, store/retrieve, distinct keys, overwrite, persist+reload, clear, corrupt file recovery
- `router.test.ts` — 8 tests: no providers, single healthy, skip unavailable, prefer local, reject remote when allowRemote=false, enforce min model class, chain ordering, empty chain
- `executor.test.ts` — 4 tests: success stream, cache hit on second call, silent degrade on no providers, fallback on failure

**Total: 30 tests pass, 0 type errors.**

## Key decisions

- **No external LLM SDK packages** — uses `fetch` directly (available in VS Code's Electron host). Keeps the bundle lean and avoids native modules.
- **Collect-then-stream for cacheable tasks** — executor collects the full stream before caching, then replays instantly from a fake stream. This means the first call isn't truly streamed but is cached for all subsequent calls.
- **Auto-detect Ollama** — if no providers are configured, `LLMManager` automatically tries `ollama:qwen2.5-coder:7b` at `http://localhost:11434`. Users get value immediately if they happen to have Ollama running.
- **`allowRemote=false` default** — local-first by default. Remote providers (Anthropic, OpenAI) require explicit opt-in.
- **Singleton ExplanationPanel** — reuses the panel across calls to avoid cluttering the editor.
- **Budget filtering skips local providers** — budget tracking only gates remote providers; local inference always allowed.

## Next phase

Phase 5 per `12-roadmap.md` — Visualisations & Fixes: godbolt-lite, code actions, verified patches, Asm Diff webview, Cache-Line Layout webview, Loop Analyser webview.

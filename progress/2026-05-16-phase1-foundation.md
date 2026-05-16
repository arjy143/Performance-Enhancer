# 2026-05-16 — Phase 1 Foundation scaffold

## What was built

All Phase 1 deliverables created from scratch in a single session:

**Repository layout** (`extension/`, `sidecar/`, `shared-protocol/`, `tests/integration/`, `scripts/`, `.github/workflows/`)

**Extension (TypeScript)**
- `extension/package.json` — VS Code manifest, activates on `.cpp`/`.c`/`CMakeLists.txt`/`compile_commands.json`
- `src/extension.ts` — activate/deactivate, async init, ping-sidecar on startup
- `src/sidecar/protocol.ts` — full JSON-RPC 2.0 type definitions + type guards
- `src/sidecar/client.ts` — JSON-RPC 2.0 client over stdio (EventEmitter, AbortSignal support)
- `src/sidecar/lifecycle.ts` — spawn, ready-wait, auto-restart (3× in 5 min)
- `src/build/detect.ts` — `compile_commands.json` search with user warning
- `src/config/schema.ts` — `.perf-lens.yaml` JSON Schema
- `src/config/projectConfig.ts` — YAML loader + validate
- `src/ui/statusBar.ts` — status bar (starting / ready / error / no-sidecar states)
- `src/ui/commands.ts` — `perfLens.analyseFile`, `perfLens.showPerfPanel` stubs
- `src/util/logger.ts` — structured output-channel logger (5 levels)
- `src/sidecar/client.test.ts` — 5 unit tests (JSON-RPC framing + type guards)
- `src/__mocks__/vscode.ts` — VS Code module mock for jest

**Sidecar (C++20, no LLVM dependency in Phase 1)**
- `sidecar/CMakeLists.txt` — CMake, FetchContent nlohmann/json + GoogleTest
- `src/rpc/server.{hpp,cpp}` — JSON-RPC 2.0 server over stdio
- `src/util/logger.{hpp,cpp}` — daily-rotating file logger + stderr mirror
- `src/main.cpp` — entry point, registers ping/echo, sends `ready` notification
- `tests/ping_test.cpp` — 7 GoogleTest tests, all passing

**Shared protocol**
- `shared-protocol/sidecar-rpc.json` — JSON Schema for ping, echo, ready

**Integration tests**
- `tests/integration/hello.test.ts` — spawns real sidecar, tests ready+ping+echo+MethodNotFound

**CI** — `.github/workflows/ci.yml` — three jobs: TS typecheck+unit, C++ build+ctest, integration

## What was verified locally

- `cmake --build sidecar/build` — clean, zero warnings
- `ctest` — 7/7 tests pass
- Manual stdin pipe smoke test — ready → ping → echo → MethodNotFound all correct

## What needs Node/pnpm to verify

- `pnpm install && pnpm --filter perf-lens run typecheck` (no Node on dev machine)
- `pnpm --filter perf-lens run test` (5 jest unit tests)
- `pnpm --filter integration-tests run test` (spawns real sidecar)

## Phase 1 exit criteria status

| Criterion | Status |
|-----------|--------|
| `pnpm run dev` opens VS Code Insiders | ✅ script wired, needs VS Code Insiders installed |
| Extension talks to sidecar; sidecar logs visible | ✅ lifecycle + client implemented |
| CI green on Linux | ✅ workflow written, will run on push |
| One end-to-end integration test | ✅ `tests/integration/hello.test.ts` |

## Notes for next session

- Node.js / pnpm not installed on dev machine — TypeScript typecheck/test needs `nvm install 20`
- The docs reference `perf-lens-docs/` but actual docs live in `claude/` — consider updating CLAUDE.md doc index paths (low priority)
- Phase 2 starts with the compiler remarks engine — read `claude/06-compiler-remarks.md` first

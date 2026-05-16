# Phase 2 — Compiler Remarks: Session Progress

## Status: COMPLETE (pending CI validation)

## What was built

### C++ sidecar (all tests passing: 30/30)

- `src/remarks/model.hpp` — `OptRemark`, `SourceLocation`, `RemarkArg`, `RemarkType`, `Category` enums
- `src/remarks/classifier.cpp` — priority-ordered pass→category mapping (16 entries)
- `src/remarks/source_hash.hpp` — FNV-1a 64-bit hash for staleness detection
- `src/remarks/parser.cpp` — Clang YAML opt-record parser (yaml-cpp `YAML::LoadAll`)
- `src/remarks/gcc_parser.cpp` — GCC opt-info regex parser
- `src/remarks/store.cpp` — SQLite WAL-mode store; `insertBulk`, `getRemarks`, `clearBuild`, `remarkedFiles`
- `src/shadow_compile.cpp` — runs compiler with `-fsave-optimization-record=yaml`, output to `.perf-lens/opt-records/`
- `src/main.cpp` — Phase 2 RPC methods: `ingestRemarksFile`, `getRemarks`, `recompileWithRemarks`, `getRemarkedFiles`
- `CMakeLists.txt` — switched from `find_package(SQLite3)` to SQLite amalgamation via FetchContent (URL hash: `77823cb...`); added `LANGUAGES C CXX`
- `tests/remarks_parser_test.cpp` — 23 tests for Classifier, ClangParser, GccParser, StoreTest
- `tests/fixtures/vec_missed.opt.yaml`, `inline_missed.opt.yaml` — test fixtures

### TypeScript extension (awaiting CI typecheck)

- `src/sidecar/protocol.ts` — added `OptRemark`, `RemarkType`, `RemarkCategory`, `CATEGORY_LABELS`, `IngestRemarksFileParams/Result`, `GetRemarksParams`, `RecompileWithRemarksParams/Result`
- `src/diagnostics/provider.ts` — `RemarksDiagnosticProvider`: diagnostics per file from sidecar
- `src/diagnostics/hover.ts` — `RemarksHoverProvider`: hover cards showing remark details
- `src/panels/remarksPanel.ts` — `RemarksTreeDataProvider`: Category > File > Remark tree
- `src/build/watcher.ts` — `OptRecordsWatcher`: watches `**/*.opt.yaml`, ingests on change
- `src/extension.ts` — wires up all Phase 2 providers; registers `perfLens.regenerateRemarks` command
- `src/ui/commands.ts` — added `perfLens.goToRemark` command
- `src/__mocks__/vscode.ts` — extended with diagnostics, hover, tree APIs
- `src/diagnostics/provider.test.ts` — 6 jest tests for `RemarksDiagnosticProvider`
- `extension/package.json` — bumped to 0.2.0; added `viewsContainers`, `views`, `perfLens.regenerateRemarks`, `perfLens.goToRemark` commands and menus

### CI

- `.github/workflows/ci.yml` — added `-DCMAKE_C_COMPILER=gcc` (needed for SQLite amalgamation .c file)

## Key decisions

- **SQLite amalgamation** instead of `libsqlite3-dev` — eliminates system package dependency; URL hash verified as `77823cb110929c2bcb0f5d48e4833b5c59a8a6e40cdea3936b99e199dbbe5784`
- **FNV-1a source hashing** for staleness — stored in DB, compared on `checkStale()`
- **WAL mode + single transaction bulk insert** for >100k remarks/min throughput

## Next phase

Phase 3 per `perf-lens-docs/docs/12-roadmap.md` — likely static analysis rules via clang-tidy integration.

# Phase 3 — Static Checks v1: Session Progress

## Status: COMPLETE (full rule tests run in CI with LLVM 19)

## What was built

### C++ sidecar

**LLVM integration (optional build):**
- `CMakeLists.txt` — `find_package(LLVM 19 CONFIG QUIET)` + conditional build; SQLite amalgamation compile option fixed to use C_COMPILER_ID
- `.github/workflows/ci.yml` — sidecar job installs `clang-19 llvm-19-dev libclang-cpp19-dev`; cmake configured with `-DLLVM_DIR=/usr/lib/llvm-19/lib/cmake/llvm -DClang_DIR=/usr/lib/llvm-19/lib/cmake/clang`

**Finding model:**
- `src/rules/finding.hpp` — `Finding`, `FindingCategory`, `ConfidenceLevel` enums + helpers
- `src/rules/finding.cpp` — `categoryName`, `confidenceName`

**FindingStore (SQLite, WAL mode):**
- `src/rules/store.hpp/cpp` — `insertBulk`, `getFindings`, `affectedFiles`, `clearFile`, `clearBuild`

**Rule infrastructure:**
- `src/rules/rule_base.hpp` — abstract `Rule` (id, title, category, confidence, registerMatchers, takeFindings)
- `src/rules/engine.hpp/cpp` — `RuleEngine`: instantiates 6 rules, runs `MatchFinder` against a TU

**AST layer:**
- `src/ast/project.hpp/cpp` — `AstProject`: loads `compile_commands.json` via `JSONCompilationDatabase`; searches 5 candidate paths
- `src/ast/translation_unit.hpp/cpp` — `TranslationUnit`: parses via `ASTUnit::LoadFromCommandLine`; re-parses on mtime change

**6 starter rules:**
| Rule | File | Key matcher |
|---|---|---|
| `noexcept.move-ops` | `function_attributes/noexcept_move_ops.cpp` | `cxxMethodDecl(anyOf(isMoveConstructor, isMoveAssignmentOperator), unless(isNoexcept))` |
| `stl.range-for-copy` | `stl_hygiene/range_for_copy.cpp` | `cxxForRangeStmt(hasLoopVariable(varDecl(unless(referenceType))))` — skips trivially copyable types |
| `stl.endl-flush` | `stl_hygiene/endl_flush.cpp` | `callExpr(callee(functionDecl(hasName("endl"), isInStdNamespace())))` |
| `hotpath.vector-no-reserve` | `hotpath/vector_no_reserve.cpp` | `cxxMemberCallExpr(callee(push_back/emplace_back on vector), hasAncestor(loop))` |
| `padding.detected` | `memory_layout/padding_detected.cpp` | `recordDecl(isStruct)` → arithmetic: `getASTRecordLayout(sizeof)` vs packed sum, fires if ≥4 bytes wasted |
| `constexpr.promotion-variable` | `constexpr/promotion_variable.cpp` | `varDecl(isConst, !isConstexpr, isInteger/float/enum)` → callback checks `isConstantInitializer` |

**RPC methods added (main.cpp v0.3.0):**
- `analyseFile(file, buildId?)` — clears old findings, runs engine, inserts, returns count
- `getFindings(file, line?)` — queries FindingStore
- `getAnalysedFiles()` — lists distinct files with findings
- `ready` notification now includes `"staticAnalysis"` capability when LLVM present

**Tests:**
- `tests/rules_test.cpp` — 17 tests: positive + negative fixture per rule + 3 FindingStore tests
- `tests/fixtures/rules/` — 10 fixture `.cpp` files
- Compiled inside `#ifdef PERF_LENS_HAVE_LLVM`; `#else` emits a skip test so CI without LLVM still passes

### TypeScript extension

- `src/sidecar/protocol.ts` — added `Finding`, `FindingCategory`, `ConfidenceLevel`, `FINDING_CATEGORY_LABELS`, `CONFIDENCE_LABELS`, `AnalyseFileParams/Result`, `GetFindingsParams`
- `src/diagnostics/findingsProvider.ts` — `FindingsDiagnosticProvider`: triggers `analyseFile` on save, populates VS Code diagnostics; `findingToMarkdown` helper for hover
- `src/extension.ts` — wires up `findingsProvider`; refreshes on activate if C/C++ file open

## Key decisions

- **LLVM optional** — Phase 1/2 builds without LLVM. CI installs LLVM 19 for full rule coverage.
- **`#ifdef PERF_LENS_HAVE_LLVM` guard** everywhere in AST/rules code — single clean build path.
- **Callback lifetime** — each `registerMatchers` call creates a fresh `Callback` raw pointer. MatchFinder owns these. Cleared between calls via `_findings.clear()`.
- **VectorNoReserveRule confidence = Medium** — can't prove absence of `reserve` call in other branches; medium is honest.
- **PaddingDetected threshold = 4 bytes** — avoids noise on 1-2 byte waste due to natural alignment.

## Next phase

Phase 4 per `12-roadmap.md` — LLM layer: provider interface, Ollama/llama.cpp adapters, prompt library, content-addressed cache.

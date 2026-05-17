# Feature Implementation — 2026-05-17

## Implemented

### New static rules (sidecar, 5 rules)
- `hotpath.shared-ptr-in-loop` — std::shared_ptr copy in loop (atomic refcount overhead)
- `stl.container-copy` — auto var = getContainer() copies (use const auto&)
- `hotpath.map-in-loop` — std::map/set lookup in loop (O(log N) tree traversal)
- `stl.string-view-param` — const std::string& param that should be string_view (low confidence)
- `hotpath.unordered-map-no-reserve` — unordered_map/set insert in loop without reserve()

All registered in engine.cpp and CMakeLists.txt. Build confirmed clean.

### suggest_novel_refactor LLM task
- Prompt in promptLibrary.ts with RefactorContext type
- suggestNovelRefactor() method in LLMManager
- perfLens.suggestRefactor command in extension.ts
- Code action in codeActionProvider.ts (appears in Ctrl+. lightbulb menu)
- Registered in package.json

### Headless CLI/CI mode (sidecar)
- --sarif=<path> flag: analyses all files in workspace, writes SARIF 2.1.0
- --sarif (no path): writes SARIF to stdout
- Graceful error if compile_commands.json not found
- Correct JSON Schema reference in SARIF output

### Flame graph panel (extension)
- FlameGraphPanel.ts: canvas-based horizontal bar chart sorted by CPU fraction
- Heat colour scale: red (>15%), orange (>8%), amber (>4%), green (>2%), blue (rest)
- Tooltip on hover: function name, %, sample count
- perfLens.showFlameGraph command (uses active profile ID)
- Registered in package.json

### Batch translate remarks command
- perfLens.translateFileRemarks: translates all remarks in active file
- Uses ExplanationPanel.startSection() for per-remark headers
- Streams each translation sequentially

### README (Readme.md)
- Rule count: 18 -> 23
- Added 5 new rules to rules table
- Added AI features section entries for suggestRefactor and translateFileRemarks
- Added headless CI mode and flame graph to Exporting results section
- Fixed remaining em-dash in ub.signed-loop-bound row

## Sidecar binary
Rebuilt and copied to extension/resources/bin/perf-lens-sidecar.

## Test status
- TypeScript: tsc --noEmit clean
- Jest: 80/80 passed
- C++ build: clean

# Perf Lens

A VS Code extension that surfaces C++ performance issues as inline diagnostics — combining static analysis, compiler optimisation remarks, and profile-guided prioritisation. All processing is local; no code leaves your machine.

---

## Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| `compile_commands.json` | Static analysis and compiler remarks | See [Generating compile_commands.json](#generating-compile_commandsjson) |
| `clang++` as your compiler | Compiler remarks via shadow-compile | `clang++-19` on Debian/Ubuntu |
| C++ compiler in PATH | Fix verification (asm diff) | GCC or clang both work |
| Ollama (optional) | AI explain / translate | `ollama pull qwen2.5-coder:7b` |
| `perf` (optional, Linux) | Profile recording and import | `sudo apt install linux-perf` |

---

## Loading the extension

The extension is loaded in development mode (no Marketplace install needed):

```bash
cd /home/arjun/code/Performance-Enhancer/extension
code --extensionDevelopmentPath=$(pwd) /path/to/your/cpp/project
```

To open the included test project that exercises every rule:

```bash
code --extensionDevelopmentPath=/home/arjun/code/Performance-Enhancer/extension \
     /home/arjun/code/perf-lens-test
```

---

## Generating compile_commands.json

**CMake** — add one flag at configure time:
```bash
cmake -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_CXX_COMPILER=clang++-19
cmake --build build
```
The file is written to `build/compile_commands.json`. Perf Lens finds it automatically.

**Any other build system** — use [Bear](https://github.com/rizsotto/Bear):
```bash
sudo apt install bear
bear -- make        # or bear -- ninja, bear -- your-build-command
```
This writes `compile_commands.json` in the project root.

---

## Features

### Static analysis

Perf Lens runs 18 rules against your source files and shows findings as yellow squiggles in the editor.

**How it works:** findings appear automatically when you open or save a `.cpp`/`.c` file. The first analysis of a large file may take 1–2 seconds; subsequent analyses are faster due to AST caching.

**Viewing findings:**
- Hover over a squiggle to see the rule explanation and a link to apply the fix
- Open the **Problems** panel (`Ctrl+Shift+M`) to see all findings across the workspace
- The finding message explains the performance impact and suggests a concrete fix

**Suppressing a finding inline:**
```cpp
int x = compute();  // perf-lens: suppress perf-lens.constexpr.promotion-variable
```

**Suppressing via `.perf-lens.yaml`** in the project root:
```yaml
suppressions:
  - file: "third_party/**"
    rules: ["*"]           # silence all rules on third-party code
  - file: "src/legacy.cpp"
    rules: ["perf-lens.padding.detected"]
```

**Rules covered:**

| Category | Rule | What it detects |
|---|---|---|
| Hot path | `hotpath.std-function` | `std::function` in a tight loop (type-erasure overhead) |
| Hot path | `hotpath.virtual-dispatch` | Virtual call inside a loop (vtable prevents inlining) |
| Hot path | `hotpath.allocation-in-loop` | `new` / `make_unique` / `malloc` inside a loop |
| Hot path | `hotpath.vector-no-reserve` | `push_back` in a loop without a preceding `reserve()` |
| Vectorisation | `vec.aliasing` | Pointer parameters without `__restrict__` (blocks auto-vectorisation) |
| Vectorisation | `vec.complex-cf` | Early `return` or `break` inside a loop body |
| Vectorisation | `vec.reduction-fp` | Floating-point `+=` reduction (non-associative; needs `-ffast-math`) |
| STL | `stl.endl-in-hot` | `std::endl` in a loop (flushes buffer on every iteration) |
| STL | `stl.range-for-copy` | `for (auto x : v)` copying non-trivial elements (should be `const auto&`) |
| Memory layout | `padding.detected` | Struct fields in sub-optimal order (wasted bytes to alignment padding) |
| Memory layout | `cache-line-straddle` | A field spanning two 64-byte cache lines |
| Memory layout | `aos-to-soa` | `vector<Struct>` with 4+ fields (Array-of-Structs candidate for SoA) |
| Const / constexpr | `constexpr.promotion-variable` | `const int x = 42` that could be `constexpr` |
| Const / constexpr | `constexpr.promotion-function` | A pure function that could be `constexpr` |
| Function attributes | `noexcept.move-ops` | Move constructor/assignment without `noexcept` (forces copy on vector resize) |
| Safety | `ub.signed-loop-bound` | Signed loop variable compared to `size()` (unsigned) — potential UB |
| Concurrency | `concurrency.mutex-where-atomic` | `std::mutex` protecting a single integer (use `std::atomic` instead) |

---

### Applying fixes and local compilation (godbolt-lite)

Perf Lens compiles C++ snippets locally using whatever compiler it finds — first from `compile_commands.json`, then `clang++` / `g++` / `c++` in PATH. No code is sent anywhere. This powers three related features:

#### Fix verification and the Asm Diff panel

For findings where an automated fix is safe, a lightbulb appears in the gutter. Press `Ctrl+.` (or click the lightbulb) to see the available code actions:

- **Perf Lens: `<description>`** — compiles the file before and after the patch, checks that the assembly actually improved, then applies the edit. Shows the **Asm Diff** panel with the result.
- **Perf Lens: Verify fix (preview asm diff)** — same compilation and diff, but does **not** apply the edit. Use this to inspect the assembly change first.

The **Asm Diff** panel shows:
- A **before / after column** layout with the full assembly of each version
- A **unified diff** below, with added lines in green and removed lines in red
- Summary stats: vector width change (`1x → 8x`), instruction count change, compile time

If verification fails (the patch didn't improve codegen), the panel shows why and the edit is not applied.

Fixes that require human judgement — such as replacing `std::function` with a template, or restructuring AoS to SoA — instead insert a `// TODO(perf-lens): ...` comment explaining the change. These are clearly labelled as guidance comments, not direct edits.

#### Loop Analyser

The Loop Analyser opens a tabbed panel alongside the editor with four views of the code around a finding:

| Tab | Contents |
|---|---|
| **Source** | The 8 lines of source around the finding, plus the finding's description |
| **Assembly** | Intel-syntax asm produced by compiling that snippet at `-O2 -std=c++20` (configurable), plus the detected vector width |
| **MCA** | `llvm-mca` throughput analysis: IPC, cycles per iteration, bottleneck resource — auto-detected if `llvm-mca` or `llvm-mca-19` is in PATH |
| **Remarks** | Compiler optimisation remarks that apply to this location (populated after running *Regenerate Remarks*) |

**Trigger it** from the hover card of any finding — click **Open Loop Analyser**.

It is most useful for vectorisation and hot-path findings: you can see immediately whether the loop vectorised, what the SIMD width is, and what the compiler said prevented optimisation.

**Change the compilation flags** via `Ctrl+,` → `perfLens.godbolt.extraFlags`. Defaults to `["-O2", "-std=c++20"]`. To test with fast-math:
```json
"perfLens.godbolt.extraFlags": ["-O2", "-std=c++20", "-march=native", "-ffast-math"]
```

> **Note on `perfLens.godbolt.enabled`:** This setting controls only the optional remote [godbolt.org](https://godbolt.org) API (sending snippets to Compiler Explorer's servers). It has no effect on local compilation, which always works. Leave it `false` unless you specifically want the remote integration.

---

### Compiler remarks

Compiler remarks are missed-optimisation notes emitted by the compiler itself (loop not vectorised, function not inlined, etc.). These are separate from and complementary to the static rules above.

**To populate remarks for the current file:**

Use the refresh button in the editor title bar, or run the command palette entry:  
`Perf Lens: Regenerate Remarks for This File`

This shadow-compiles the file with `-fsave-optimization-record` using the flags from `compile_commands.json` and ingests the results. Requires `clang++` as the compiler.

Remarks appear as blue (information) squiggles. Hover to see the raw remark. Click **Translate with AI** in the hover to get a plain-English explanation (requires an LLM provider).

The **Compiler Remarks** panel in the activity bar groups remarks by file and category.

---

### AI explain and translate

With an LLM provider configured, two AI features become available:

- **Explain with AI** — shown in the hover card of any finding; explains why the pattern hurts performance and what to do about it in the context of your specific code
- **Translate Remark** — converts a raw compiler remark (`loop not vectorized: unsafe dependent memory operations`) into plain English

**Configure Ollama (local, no API key):**
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:7b
```
Then in VS Code settings (`Ctrl+,`), set:
```
perfLens.llm.primary = ollama:qwen2.5-coder:7b
```

**Configure a remote provider** via `Ctrl+,` → search `perfLens.llm.providers`:
```json
[
  {
    "id": "claude",
    "type": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "sk-ant-..."
  }
]
```
Remote providers are opt-in and disabled by default (`perfLens.llm.allowRemote: false`).

---

### Profile import and hotness

Importing a profile re-sorts all findings by measured hotness and adds `[X.X% cycles]` annotations to the most critical lines.

**Import a perf profile:**

1. Record a profile:
   ```bash
   perf record -g -F 99 ./your-binary
   ```
2. In VS Code: `Ctrl+Shift+P` → `Perf Lens: Import Profile…` → select `perf.data`

   Alternatively, convert first and import the text file:
   ```bash
   perf script > profile.txt
   ```
   Then import `profile.txt`.

3. The gutter heatmap appears immediately. Hot lines glow orange/red; cold lines are dim.

**Record directly from VS Code:**  
`Ctrl+Shift+P` → `Perf Lens: Record Profile…` — opens a panel where you enter the binary path and arguments, then click Record. Requires `perf` in PATH with `kernel.perf_event_paranoid ≤ 1`.

**Compare two profiles:**  
`Ctrl+Shift+P` → `Perf Lens: Compare Profiles…` — shows a diff view highlighting functions that regressed or improved between two recorded profiles.

---

### Exporting results

**SARIF export** (for CI or code review tools):  
`Ctrl+Shift+P` → `Perf Lens: Export Findings as SARIF…`

**Diagnostic bundle** (full JSON snapshot of findings, remarks, and profile data):  
`Ctrl+Shift+P` → `Perf Lens: Export Diagnostic Bundle…`

---

## Settings reference

| Setting | Default | Description |
|---|---|---|
| `perfLens.analyseOnOpen` | `true` | Analyse each C++ file when it is opened |
| `perfLens.analyseOnSave` | `true` | Re-analyse on every save |
| `perfLens.minConfidence` | `medium` | Hide findings below this confidence level (`high`/`medium`/`low`) |
| `perfLens.ui.maxFindingsPerFile` | `50` | Cap on findings shown per file |
| `perfLens.ui.showGutterHeatmap` | `true` | Show hotness colours in the gutter when a profile is loaded |
| `perfLens.llm.primary` | `""` | Primary LLM in the form `provider:model` (e.g. `ollama:qwen2.5-coder:7b`) |
| `perfLens.llm.allowRemote` | `false` | Allow sending code to remote (non-local) LLM providers |
| `perfLens.llm.budgetUSD` | unset | Monthly spend cap for remote providers |
| `perfLens.godbolt.extraFlags` | `["-O2", "-std=c++20"]` | Compiler flags used for snippet compilation (fix verification, Loop Analyser) |
| `perfLens.godbolt.enabled` | `false` | Enable the optional remote godbolt.org API (local compilation always works without this) |

All settings are under `Ctrl+,` → search **Perf Lens**.

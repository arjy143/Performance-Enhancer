cmake_minimum_required(VERSION 3.25)
project(perf-lens-sidecar VERSION 0.4.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

# nlohmann/json — JSON-RPC messages, compile_commands.json parsing
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)

# yaml-cpp — Clang opt-record YAML parsing
FetchContent_Declare(
  yaml-cpp
  GIT_REPOSITORY https://github.com/jbeder/yaml-cpp.git
  GIT_TAG        0.8.0
  GIT_SHALLOW    TRUE
)
set(YAML_CPP_BUILD_TESTS   OFF CACHE BOOL "" FORCE)
set(YAML_CPP_BUILD_TOOLS   OFF CACHE BOOL "" FORCE)
set(YAML_CPP_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(nlohmann_json yaml-cpp)

# SQLite3 — bundled amalgamation so no system package is needed
FetchContent_Declare(
  sqlite_amalgamation
  URL      https://www.sqlite.org/2024/sqlite-amalgamation-3460100.zip
  URL_HASH SHA256=77823cb110929c2bcb0f5d48e4833b5c59a8a6e40cdea3936b99e199dbbe5784
)
FetchContent_MakeAvailable(sqlite_amalgamation)

add_library(sqlite3_amalgamation STATIC
  ${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c
)
target_include_directories(sqlite3_amalgamation PUBLIC
  ${sqlite_amalgamation_SOURCE_DIR}
)
target_compile_options(sqlite3_amalgamation PRIVATE
  $<$<C_COMPILER_ID:GNU,Clang>:-w>
)

# ---------------------------------------------------------------------------
# LLVM/Clang — optional; required for Phase 3 static analysis rules.
# Install: sudo apt-get install clang-19 llvm-19-dev libclang-cpp19-dev
# Configure: cmake ... -DLLVM_DIR=/usr/lib/llvm-19/lib/cmake/llvm
#                      -DClang_DIR=/usr/lib/llvm-19/lib/cmake/clang
# ---------------------------------------------------------------------------
find_package(LLVM 19 CONFIG QUIET)
find_package(Clang CONFIG QUIET)

if(LLVM_FOUND AND Clang_FOUND)
    message(STATUS "LLVM ${LLVM_VERSION} — static analysis rules ENABLED")
    set(PERF_LENS_HAVE_LLVM TRUE)
    include_directories(${LLVM_INCLUDE_DIRS} ${CLANG_INCLUDE_DIRS})
    add_definitions(${LLVM_DEFINITIONS})
else()
    message(STATUS "LLVM/Clang not found — static analysis rules DISABLED (Phase 1/2 features unaffected)")
    set(PERF_LENS_HAVE_LLVM FALSE)
endif()

# ---------------------------------------------------------------------------
# Core library — shared between the binary and the test suite
# ---------------------------------------------------------------------------
add_library(perf-lens-sidecar-lib STATIC
  src/rpc/server.cpp
  src/util/logger.cpp
  src/remarks/classifier.cpp
  src/remarks/parser.cpp
  src/remarks/gcc_parser.cpp
  src/remarks/store.cpp
  src/rules/finding.cpp
  src/rules/store.cpp
  src/shadow_compile.cpp
  # Phase 5: Godbolt-Lite (always built — no LLVM dependency)
  src/godbolt/asm_parser.cpp
  src/godbolt/diff_engine.cpp
  src/godbolt/compile_cache.cpp
  src/godbolt/compiler.cpp
  # Phase 6: Profile Integration
  src/profile/store.cpp
  src/rules/packs/profile_driven/profile_rules.cpp
)

target_include_directories(perf-lens-sidecar-lib PUBLIC src)
target_link_libraries(perf-lens-sidecar-lib PUBLIC
  nlohmann_json::nlohmann_json
  yaml-cpp::yaml-cpp
  sqlite3_amalgamation
)

if(PERF_LENS_HAVE_LLVM)
    target_sources(perf-lens-sidecar-lib PRIVATE
        src/ast/project.cpp
        src/ast/translation_unit.cpp
        src/rules/engine.cpp
        src/rules/packs/function_attributes/noexcept_move_ops.cpp
        src/rules/packs/stl_hygiene/range_for_copy.cpp
        src/rules/packs/stl_hygiene/endl_flush.cpp
        src/rules/packs/hotpath/vector_no_reserve.cpp
        src/rules/packs/memory_layout/padding_detected.cpp
        src/rules/packs/constexpr/promotion_variable.cpp
    )
    target_compile_definitions(perf-lens-sidecar-lib PUBLIC PERF_LENS_HAVE_LLVM)
    target_link_libraries(perf-lens-sidecar-lib PUBLIC
        clangTooling
        clangASTMatchers
        clangAST
        clangBasic
        clangFrontend
        clangSerialization
        clangSema
        clangAnalysis
        clangEdit
        clangDriver
        clangParse
        clangLex
        LLVMSupport
        LLVMCore
    )
endif()

target_compile_options(perf-lens-sidecar-lib PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# ---------------------------------------------------------------------------
# Main binary
# ---------------------------------------------------------------------------
add_executable(perf-lens-sidecar src/main.cpp)
target_link_libraries(perf-lens-sidecar PRIVATE perf-lens-sidecar-lib)
target_compile_options(perf-lens-sidecar PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
enable_testing()
add_subdirectory(tests)

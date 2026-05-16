cmake_minimum_required(VERSION 3.25)
project(perf-lens-sidecar VERSION 0.2.0 LANGUAGES C CXX)

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
# SQLite amalgamation does not compile cleanly under strict C++ pedantic warnings
target_compile_options(sqlite3_amalgamation PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-w>
)

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
  src/shadow_compile.cpp
)

target_include_directories(perf-lens-sidecar-lib PUBLIC src)
target_link_libraries(perf-lens-sidecar-lib PUBLIC
  nlohmann_json::nlohmann_json
  yaml-cpp::yaml-cpp
  sqlite3_amalgamation
)

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

cmake_minimum_required(VERSION 3.25)
project(perf-lens-sidecar VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Fetch nlohmann/json (header-only, no LLVM dependency in Phase 1)
include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(nlohmann_json)

# Core logic as a static library (shared by binary and tests)
add_library(perf-lens-sidecar-lib STATIC
  src/rpc/server.cpp
  src/util/logger.cpp
)

target_include_directories(perf-lens-sidecar-lib PUBLIC src)
target_link_libraries(perf-lens-sidecar-lib PUBLIC nlohmann_json::nlohmann_json)

target_compile_options(perf-lens-sidecar-lib PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# Main binary
add_executable(perf-lens-sidecar src/main.cpp)
target_link_libraries(perf-lens-sidecar PRIVATE perf-lens-sidecar-lib)

target_compile_options(perf-lens-sidecar PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
)

# Tests
enable_testing()
add_subdirectory(tests)

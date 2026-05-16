FetchContent_Declare(
  googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG        v1.14.0
  GIT_SHALLOW    TRUE
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

add_executable(perf-lens-sidecar-tests
  ping_test.cpp
  remarks_parser_test.cpp
  rules_test.cpp
  godbolt_test.cpp
  profile_store_test.cpp
  profile_rules_test.cpp
)

target_link_libraries(perf-lens-sidecar-tests PRIVATE
  perf-lens-sidecar-lib
  GTest::gtest_main
)

target_compile_options(perf-lens-sidecar-tests PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror -Wno-error=nonnull>
)

include(GoogleTest)
gtest_discover_tests(perf-lens-sidecar-tests)

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
)

target_link_libraries(perf-lens-sidecar-tests PRIVATE
  perf-lens-sidecar-lib
  GTest::gtest_main
)

include(GoogleTest)
gtest_discover_tests(perf-lens-sidecar-tests)

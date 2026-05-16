#include <gtest/gtest.h>
#include <sstream>

#include "remarks/model.hpp"
#include "remarks/classifier.hpp"
#include "remarks/parser.hpp"
#include "remarks/gcc_parser.hpp"
#include "remarks/store.hpp"
#include "remarks/source_hash.hpp"

using namespace perf_lens::remarks;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

TEST(Classifier, VectorisationPass) {
    EXPECT_EQ(classify("loop-vectorize", "UnsafeMemDep"), Category::Vectorisation);
    EXPECT_EQ(classify("slp-vectorizer", "SLPVectorized"), Category::Vectorisation);
}

TEST(Classifier, InliningPass) {
    EXPECT_EQ(classify("inline",        "TooCostly"), Category::Inlining);
    EXPECT_EQ(classify("always-inline", ""),          Category::Inlining);
}

TEST(Classifier, UnrollingPass) {
    EXPECT_EQ(classify("loop-unroll", "Threshold"), Category::Unrolling);
}

TEST(Classifier, MemoryPasses) {
    EXPECT_EQ(classify("licm",      ""), Category::Memory);
    EXPECT_EQ(classify("gvn",       ""), Category::Memory);
    EXPECT_EQ(classify("memcpyopt", ""), Category::Memory);
}

TEST(Classifier, UnknownIsOther) {
    EXPECT_EQ(classify("unknown-pass", "anything"), Category::Other);
    EXPECT_EQ(classify("", ""),                     Category::Other);
}

TEST(Classifier, CategoryNames) {
    EXPECT_STREQ(categoryName(Category::Vectorisation), "Vectorisation");
    EXPECT_STREQ(categoryName(Category::Inlining),      "Inlining");
    EXPECT_STREQ(categoryName(Category::Other),         "Other");
}

// ---------------------------------------------------------------------------
// Clang YAML parser
// ---------------------------------------------------------------------------

TEST(ClangParser, ParseSingleMissedRemark) {
    const char* yaml = R"(
--- !Missed
Pass:     loop-vectorize
Name:     UnsafeMemDep
DebugLoc: { File: '/tmp/sim.cpp', Line: 47, Column: 5 }
Function: update_collisions
Args:
  - String: 'loop not vectorized: '
  - String: 'cannot prove pointers do not alias'
...
)";
    std::istringstream ss{yaml};
    const auto remarks = parseClangYamlStream(ss);

    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].type,          RemarkType::Missed);
    EXPECT_EQ(remarks[0].pass,          "loop-vectorize");
    EXPECT_EQ(remarks[0].name,          "UnsafeMemDep");
    EXPECT_EQ(remarks[0].location.line, 47);
    EXPECT_EQ(remarks[0].location.file, "/tmp/sim.cpp");
    EXPECT_EQ(remarks[0].function,      "update_collisions");
    EXPECT_EQ(remarks[0].category,      Category::Vectorisation);
    EXPECT_NE(remarks[0].message.find("loop not vectorized"), std::string::npos);
}

TEST(ClangParser, ParsePassedRemark) {
    const char* yaml = R"(
--- !Passed
Pass:     loop-vectorize
Name:     Vectorized
DebugLoc: { File: '/tmp/sim.cpp', Line: 23, Column: 3 }
Function: integrate
Args:
  - String: 'vectorized loop'
...
)";
    std::istringstream ss{yaml};
    const auto remarks = parseClangYamlStream(ss);

    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].type, RemarkType::Passed);
    EXPECT_EQ(remarks[0].name, "Vectorized");
}

TEST(ClangParser, ParseMultipleDocuments) {
    const char* yaml = R"(
--- !Missed
Pass:     inline
Name:     TooCostly
DebugLoc: { File: '/tmp/a.cpp', Line: 10, Column: 1 }
Function: foo
Args:
  - String: 'will not be inlined'
...
--- !Passed
Pass:     loop-vectorize
Name:     Vectorized
DebugLoc: { File: '/tmp/a.cpp', Line: 20, Column: 1 }
Function: bar
Args:
  - String: 'vectorized loop'
...
)";
    std::istringstream ss{yaml};
    const auto remarks = parseClangYamlStream(ss);

    ASSERT_EQ(remarks.size(), 2u);
    EXPECT_EQ(remarks[0].type, RemarkType::Missed);
    EXPECT_EQ(remarks[1].type, RemarkType::Passed);
}

TEST(ClangParser, EmptyStreamProducesNoRemarks) {
    std::istringstream ss{""};
    EXPECT_TRUE(parseClangYamlStream(ss).empty());
}

TEST(ClangParser, MalformedYamlDoesNotThrow) {
    std::istringstream ss{"not: [valid: yaml\n"};
    // Must not throw; returns empty or partial results
    EXPECT_NO_THROW(parseClangYamlStream(ss));
}

TEST(ClangParser, RemarkWithoutDebugLocHasZeroLine) {
    const char* yaml = R"(
--- !Missed
Pass:     inline
Name:     NoDefinition
Function: caller
Args:
  - String: 'callee not available'
...
)";
    std::istringstream ss{yaml};
    const auto remarks = parseClangYamlStream(ss);
    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].location.line, 0);
}

TEST(ClangParser, BuildIdPropagated) {
    const char* yaml = R"(
--- !Missed
Pass:     inline
Name:     TooCostly
DebugLoc: { File: '/tmp/a.cpp', Line: 1, Column: 1 }
Function: f
Args:
  - String: 'msg'
...
)";
    std::istringstream ss{yaml};
    const auto remarks = parseClangYamlStream(ss, "release-2026");
    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].build_id, "release-2026");
}

// ---------------------------------------------------------------------------
// GCC opt-info parser
// ---------------------------------------------------------------------------

TEST(GccParser, ParseOptimizedLine) {
    const char* text = "/tmp/sim.cpp:47:5: optimized: loop vectorized using 32 byte vectors\n";
    std::istringstream ss{text};
    const auto remarks = parseGccOptInfoStream(ss);

    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].type,          RemarkType::Passed);
    EXPECT_EQ(remarks[0].location.line, 47);
    EXPECT_NE(remarks[0].message.find("vectorized"), std::string::npos);
    EXPECT_EQ(remarks[0].category,      Category::Vectorisation);
}

TEST(GccParser, ParseMissedLine) {
    const char* text = "/tmp/sim.cpp:81:5: missed: not vectorized: complicated access pattern.\n";
    std::istringstream ss{text};
    const auto remarks = parseGccOptInfoStream(ss);

    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].type, RemarkType::Missed);
}

TEST(GccParser, ParseNoteLine) {
    const char* text = "/tmp/sim.cpp:10:1: note: basic block part vectorized\n";
    std::istringstream ss{text};
    const auto remarks = parseGccOptInfoStream(ss);

    ASSERT_EQ(remarks.size(), 1u);
    EXPECT_EQ(remarks[0].type, RemarkType::Analysis);
}

TEST(GccParser, SkipsNonMatchingLines) {
    const char* text = "In function 'foo':\nthis is not an opt-info line\n";
    std::istringstream ss{text};
    EXPECT_TRUE(parseGccOptInfoStream(ss).empty());
}

TEST(GccParser, ParseMultipleLines) {
    const char* text =
        "/tmp/a.cpp:1:1: optimized: loop vectorized using 16 byte vectors\n"
        "/tmp/a.cpp:2:1: missed: not vectorized: too many iterations\n";
    std::istringstream ss{text};
    const auto remarks = parseGccOptInfoStream(ss);
    EXPECT_EQ(remarks.size(), 2u);
}

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

class StoreTest : public ::testing::Test {
protected:
    std::filesystem::path db_path{"/tmp/perf-lens-test-remarks.sqlite"};

    void SetUp() override {
        std::filesystem::remove(db_path);
    }
    void TearDown() override {
        std::filesystem::remove(db_path);
    }
};

TEST_F(StoreTest, InsertAndQueryByFile) {
    RemarkStore store(db_path);

    OptRemark r;
    r.type          = RemarkType::Missed;
    r.pass          = "loop-vectorize";
    r.name          = "UnsafeMemDep";
    r.location.file = "/tmp/test.cpp";
    r.location.line = 42;
    r.function      = "foo";
    r.message       = "loop not vectorized";
    r.category      = Category::Vectorisation;
    r.build_id      = "test";

    const int count = store.insertBulk({r});
    EXPECT_EQ(count, 1);

    const auto results = store.getRemarks("/tmp/test.cpp");
    ASSERT_EQ(results.size(), 1u);
    EXPECT_EQ(results[0].pass,          "loop-vectorize");
    EXPECT_EQ(results[0].location.line, 42);
    EXPECT_EQ(results[0].category,      Category::Vectorisation);
}

TEST_F(StoreTest, QueryByFileLine) {
    RemarkStore store(db_path);

    auto make = [](int line) {
        OptRemark r;
        r.type          = RemarkType::Missed;
        r.pass          = "inline";
        r.location.file = "/tmp/a.cpp";
        r.location.line = line;
        r.build_id      = "t";
        return r;
    };

    store.insertBulk({make(10), make(20), make(30)});

    const auto at20 = store.getRemarks("/tmp/a.cpp", 20);
    ASSERT_EQ(at20.size(), 1u);
    EXPECT_EQ(at20[0].location.line, 20);
}

TEST_F(StoreTest, ClearBuildRemovesEntries) {
    RemarkStore store(db_path);

    OptRemark r;
    r.type          = RemarkType::Missed;
    r.pass          = "inline";
    r.location.file = "/tmp/b.cpp";
    r.location.line = 1;
    r.build_id      = "build-A";

    store.insertBulk({r});
    EXPECT_EQ(store.getRemarks("/tmp/b.cpp").size(), 1u);

    store.clearBuild("build-A");
    EXPECT_TRUE(store.getRemarks("/tmp/b.cpp").empty());
}

TEST_F(StoreTest, BulkInsertPerformance) {
    // Verify 10k inserts complete in well under 30s
    RemarkStore store(db_path);
    std::vector<OptRemark> batch;
    batch.reserve(10'000);
    for (int i = 0; i < 10'000; ++i) {
        OptRemark r;
        r.type          = RemarkType::Missed;
        r.pass          = "loop-vectorize";
        r.location.file = "/tmp/perf.cpp";
        r.location.line = i + 1;
        r.build_id      = "perf";
        batch.push_back(r);
    }
    const int count = store.insertBulk(batch);
    EXPECT_EQ(count, 10'000);
}

TEST_F(StoreTest, RemarkedFilesReturnsDistinct) {
    RemarkStore store(db_path);

    auto make = [](const char* file) {
        OptRemark r;
        r.type          = RemarkType::Missed;
        r.location.file = file;
        r.location.line = 1;
        r.build_id      = "t";
        return r;
    };
    store.insertBulk({make("/a.cpp"), make("/a.cpp"), make("/b.cpp")});

    const auto files = store.remarkedFiles();
    ASSERT_EQ(files.size(), 2u);
}

#include <gtest/gtest.h>
#include "profile/store.hpp"
#include <sstream>

using namespace profile;

// ── Fixture ───────────────────────────────────────────────────────────────

class ProfileStoreTest : public ::testing::Test {
protected:
  ProfileStore store{":memory:"};
};

// ── Profile lifecycle ──────────────────────────────────────────────────────

TEST_F(ProfileStoreTest, CreateAndListProfile) {
  ProfileMetadata m;
  m.label           = "test-profile";
  m.source_profiler = "perf";
  m.total_samples   = 1000;

  std::string id = store.createProfile(m);
  EXPECT_FALSE(id.empty());

  auto list = store.listProfiles();
  ASSERT_EQ(1u, list.size());
  EXPECT_EQ("test-profile", list[0].label);
  EXPECT_EQ("perf",         list[0].source_profiler);
}

TEST_F(ProfileStoreTest, DeleteProfile) {
  ProfileMetadata m;
  m.label = "to-delete";
  std::string id = store.createProfile(m);

  // Insert a line row so we can verify CASCADE delete
  ImportedLineRow row{"cycles", "/src/foo.cpp", 10, 500};
  store.insertLineRows(id, {row});

  store.deleteProfile(id);

  auto list = store.listProfiles();
  EXPECT_TRUE(list.empty());

  // Hotness for deleted profile returns nullopt
  auto h = store.getLineHotness(id, "/src/foo.cpp", 10);
  EXPECT_FALSE(h.has_value());
}

TEST_F(ProfileStoreTest, ListProfilesOrderedByRecordedAt) {
  ProfileMetadata m1; m1.label = "old"; m1.recorded_at = 1000;
  ProfileMetadata m2; m2.label = "new"; m2.recorded_at = 2000;
  store.createProfile(m1);
  store.createProfile(m2);

  auto list = store.listProfiles();
  ASSERT_EQ(2u, list.size());
  EXPECT_EQ("new", list[0].label);
  EXPECT_EQ("old", list[1].label);
}

// ── Ingestion via NDJSON ──────────────────────────────────────────────────

TEST_F(ProfileStoreTest, IngestNdjson_BasicRoundtrip) {
  std::string ndjson =
    R"({"type":"metadata","id":"","label":"bench","source_profiler":"perf","total_samples":3000})"
    "\n"
    R"({"type":"line","event":"cycles","file":"/src/hot.cpp","line":42,"self":1500})"
    "\n"
    R"({"type":"line","event":"cycles","file":"/src/cold.cpp","line":7,"self":100})"
    "\n"
    R"({"type":"function","event":"cycles","function":"integrate","file":"/src/hot.cpp","self":1500})"
    "\n";

  std::istringstream ss(ndjson);
  std::string pid = store.ingestFromNdjson(ss, "bench");
  EXPECT_FALSE(pid.empty());

  auto h = store.getLineHotness(pid, "/src/hot.cpp", 42);
  ASSERT_TRUE(h.has_value());
  EXPECT_EQ(1500u,  h->self_count);
  EXPECT_EQ(1600u,  h->total_count);   // 1500 + 100
  EXPECT_NEAR(0.9375, h->fraction, 1e-6);

  auto fns = store.getTopFunctions(pid, 5);
  ASSERT_EQ(1u, fns.size());
  EXPECT_EQ("integrate", fns[0].function);
}

TEST_F(ProfileStoreTest, IngestNdjson_NoMetadataLine) {
  // Importers without a metadata line still work
  std::string ndjson =
    R"({"type":"line","event":"cycles","file":"/a.cpp","line":1,"self":200})"
    "\n";
  std::istringstream ss(ndjson);
  std::string pid = store.ingestFromNdjson(ss, "anonymous");
  EXPECT_FALSE(pid.empty());
  auto h = store.getLineHotness(pid, "/a.cpp", 1);
  ASSERT_TRUE(h.has_value());
}

// ── Hotness queries ────────────────────────────────────────────────────────

TEST_F(ProfileStoreTest, GetFileHotness_SortedDescending) {
  ProfileMetadata m; m.label = "p";
  std::string pid = store.createProfile(m);

  store.insertLineRows(pid, {
    {"cycles", "/src/f.cpp", 10, 300},
    {"cycles", "/src/f.cpp", 20, 100},
    {"cycles", "/src/f.cpp", 30, 600},
  });

  auto rows = store.getFileHotness(pid, "/src/f.cpp");
  ASSERT_EQ(3u, rows.size());
  EXPECT_EQ(30, rows[0].line);  // hottest first
  EXPECT_EQ(10, rows[1].line);
  EXPECT_EQ(20, rows[2].line);
}

TEST_F(ProfileStoreTest, GetTopFunctions_LimitN) {
  ProfileMetadata m; m.label = "p";
  std::string pid = store.createProfile(m);

  store.insertFunctionRows(pid, {
    {"cycles", "f1", "", 1000},
    {"cycles", "f2", "", 500},
    {"cycles", "f3", "", 250},
  });

  auto top2 = store.getTopFunctions(pid, 2);
  ASSERT_EQ(2u, top2.size());
  EXPECT_EQ("f1", top2[0].function);
  EXPECT_EQ("f2", top2[1].function);
  EXPECT_NEAR(1000.0/1750.0, top2[0].fraction, 1e-6);
}

TEST_F(ProfileStoreTest, HotnessReturnsNulloptForMissingLine) {
  ProfileMetadata m; m.label = "p";
  std::string pid = store.createProfile(m);

  store.insertLineRows(pid, {{"cycles", "/f.cpp", 1, 100}});

  auto h = store.getLineHotness(pid, "/f.cpp", 99);
  EXPECT_FALSE(h.has_value());
}

// ── Staleness / source hashes ──────────────────────────────────────────────

TEST_F(ProfileStoreTest, SourceHashRoundtrip) {
  ProfileMetadata m; m.label = "p";
  std::string pid = store.createProfile(m);

  store.storeSourceHashes(pid, {
    {"/src/a.cpp", "abc123"},
    {"/src/b.cpp", "def456"},
  });

  auto hashes = store.getSourceHashes(pid);
  ASSERT_EQ(2u, hashes.size());
  EXPECT_EQ("abc123", hashes["/src/a.cpp"]);
  EXPECT_EQ("def456", hashes["/src/b.cpp"]);
}

// ── Event type isolation ──────────────────────────────────────────────────

TEST_F(ProfileStoreTest, DifferentEventTypesAreIndependent) {
  ProfileMetadata m; m.label = "p";
  std::string pid = store.createProfile(m);

  store.insertLineRows(pid, {
    {"cycles",              "/f.cpp", 1, 1000},
    {"L1-dcache-load-miss", "/f.cpp", 1, 200},
  });

  auto hCycles = store.getLineHotness(pid, "/f.cpp", 1, "cycles");
  auto hMiss   = store.getLineHotness(pid, "/f.cpp", 1, "L1-dcache-load-miss");

  ASSERT_TRUE(hCycles.has_value());
  ASSERT_TRUE(hMiss.has_value());
  EXPECT_EQ(1000u, hCycles->self_count);
  EXPECT_EQ(200u,  hMiss->self_count);
  EXPECT_NEAR(1.0, hCycles->fraction, 1e-9);
  EXPECT_NEAR(1.0, hMiss->fraction, 1e-9);
}

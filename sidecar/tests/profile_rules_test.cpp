#include <gtest/gtest.h>
#include "profile/store.hpp"
#include "rules/packs/profile_driven/profile_rules.hpp"
#include <algorithm>

using namespace profile;
using namespace perf_lens::rules;
using namespace perf_lens::rules::profile_driven;

// ── Fixture ───────────────────────────────────────────────────────────────

class ProfileRulesTest : public ::testing::Test {
protected:
  ProfileStore store{":memory:"};

  std::string makeProfile() {
    ProfileMetadata m;
    m.label = "bench";
    return store.createProfile(m);
  }
};

// ── cache-miss-hotspot ────────────────────────────────────────────────────

TEST_F(ProfileRulesTest, CacheMissHotspot_FiresOnHotLineWithHighMissRate) {
  std::string pid = makeProfile();
  // Line 42: 20% of cycles, 30% of L1 misses → should fire
  store.insertLineRows(pid, {
    {"cycles",               "/src/sim.cpp", 42, 200},
    {"cycles",               "/src/sim.cpp", 10, 800},
    {"L1-dcache-load-misses","/src/sim.cpp", 42, 300},
    {"L1-dcache-load-misses","/src/sim.cpp", 10, 700},
  });

  auto findings = analyseFileWithProfile(pid, "/src/sim.cpp", store);
  auto it = std::find_if(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.cache-miss-hotspot" && f.line == 42;
  });
  EXPECT_NE(it, findings.end()) << "cache-miss-hotspot should fire on line 42";
}

TEST_F(ProfileRulesTest, CacheMissHotspot_NoFireWhenCoolLine) {
  std::string pid = makeProfile();
  // Line 42: only 1% of cycles → below 5% threshold
  store.insertLineRows(pid, {
    {"cycles",               "/src/f.cpp", 42, 10},
    {"cycles",               "/src/f.cpp",  1, 990},
    {"L1-dcache-load-misses","/src/f.cpp", 42, 300},
    {"L1-dcache-load-misses","/src/f.cpp",  1, 700},
  });

  auto findings = analyseFileWithProfile(pid, "/src/f.cpp", store);
  bool fired = std::any_of(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.cache-miss-hotspot" && f.line == 42;
  });
  EXPECT_FALSE(fired);
}

TEST_F(ProfileRulesTest, CacheMissHotspot_NoFireWithoutMissEvent) {
  std::string pid = makeProfile();
  // Hot line but no L1 miss data
  store.insertLineRows(pid, {
    {"cycles", "/src/g.cpp", 5, 800},
    {"cycles", "/src/g.cpp", 6, 200},
  });

  auto findings = analyseFileWithProfile(pid, "/src/g.cpp", store);
  bool fired = std::any_of(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.cache-miss-hotspot";
  });
  EXPECT_FALSE(fired);
}

// ── branch-mispredict ─────────────────────────────────────────────────────

TEST_F(ProfileRulesTest, BranchMispredict_FiresOnHotBranchLine) {
  std::string pid = makeProfile();
  store.insertLineRows(pid, {
    {"cycles",         "/src/search.cpp", 10, 100},
    {"cycles",         "/src/search.cpp", 20, 900},
    {"branch-misses",  "/src/search.cpp", 20, 200},
    {"branch-misses",  "/src/search.cpp", 30, 800},
  });

  auto findings = analyseFileWithProfile(pid, "/src/search.cpp", store);
  // Line 20: 10% of cycles + 20% branch misses → both thresholds met
  bool fired = std::any_of(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.branch-mispredict" && f.line == 20;
  });
  EXPECT_TRUE(fired);
}

// ── memory-bandwidth-bound ────────────────────────────────────────────────

TEST_F(ProfileRulesTest, MemoryBandwidth_FiresOnLLCMissHotLine) {
  std::string pid = makeProfile();
  store.insertLineRows(pid, {
    {"cycles",         "/src/bw.cpp", 7, 300},
    {"cycles",         "/src/bw.cpp", 8, 700},
    {"LLC-load-misses","/src/bw.cpp", 7, 200},
    {"LLC-load-misses","/src/bw.cpp", 8, 800},
  });

  auto findings = analyseFileWithProfile(pid, "/src/bw.cpp", store);
  bool fired = std::any_of(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.memory-bandwidth-bound" && f.line == 7;
  });
  EXPECT_TRUE(fired);
}

// ── low-IPC ───────────────────────────────────────────────────────────────

TEST_F(ProfileRulesTest, LowIpc_FiresOnHotLineWithNoMisses) {
  std::string pid = makeProfile();
  // Line 3: 30% of cycles, no L1 misses → compute-bound
  store.insertLineRows(pid, {
    {"cycles", "/src/compute.cpp",  3, 300},
    {"cycles", "/src/compute.cpp", 10, 700},
    // No L1-dcache-load-misses rows at all
  });

  auto findings = analyseFileWithProfile(pid, "/src/compute.cpp", store);
  bool fired = std::any_of(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.low-ipc" && f.line == 3;
  });
  EXPECT_TRUE(fired);
}

// ── finding metadata ──────────────────────────────────────────────────────

TEST_F(ProfileRulesTest, FindingHasCorrectMetadata) {
  std::string pid = makeProfile();
  store.insertLineRows(pid, {
    {"cycles",               "/src/h.cpp", 1, 500},
    {"cycles",               "/src/h.cpp", 2, 500},
    {"L1-dcache-load-misses","/src/h.cpp", 1, 200},
    {"L1-dcache-load-misses","/src/h.cpp", 2, 800},
  });

  auto findings = analyseFileWithProfile(pid, "/src/h.cpp", store);
  auto it = std::find_if(findings.begin(), findings.end(), [](const Finding& f) {
    return f.rule_id == "perf-lens.profile.cache-miss-hotspot";
  });
  if (it != findings.end()) {
    EXPECT_FALSE(it->title.empty());
    EXPECT_FALSE(it->message.empty());
    EXPECT_EQ(it->category,   FindingCategory::MemoryLayout);
    EXPECT_EQ(it->confidence, ConfidenceLevel::High);
    EXPECT_EQ(it->build_id,   "profile");
  }
}

// ── empty profile returns no findings ─────────────────────────────────────

TEST_F(ProfileRulesTest, EmptyProfile_NoFindings) {
  std::string pid = makeProfile();
  // No hotness data at all
  auto findings = analyseFileWithProfile(pid, "/src/empty.cpp", store);
  EXPECT_TRUE(findings.empty());
}

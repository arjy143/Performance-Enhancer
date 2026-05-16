#pragma once
#ifdef PERF_LENS_HAVE_LLVM
#include "rules/rule_base.hpp"
namespace perf_lens::rules {
class VectorNoReserveRule final : public Rule {
public:
    const char* id()    const noexcept override { return "perf-lens.hotpath.vector-no-reserve"; }
    const char* title() const noexcept override { return "push_back in loop without reserve"; }
    FindingCategory category()   const noexcept override { return FindingCategory::HotPath; }
    ConfidenceLevel confidence() const noexcept override { return ConfidenceLevel::Medium; }
    void registerMatchers(MatchFinder& finder, const std::string& build_id) override;
    std::vector<Finding> takeFindings() override;
private:
    std::string _build_id;
    std::vector<Finding> _findings;
};
} // namespace perf_lens::rules
#endif

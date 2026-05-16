#pragma once
#ifdef PERF_LENS_HAVE_LLVM
#include "rules/rule_base.hpp"
namespace perf_lens::rules {
class EndlFlushRule final : public Rule {
public:
    const char* id()    const noexcept override { return "perf-lens.stl.endl-flush"; }
    const char* title() const noexcept override { return "std::endl forces a flush; prefer '\\n'"; }
    FindingCategory category()   const noexcept override { return FindingCategory::StlHygiene; }
    ConfidenceLevel confidence() const noexcept override { return ConfidenceLevel::High; }
    void registerMatchers(MatchFinder& finder, const std::string& build_id) override;
    std::vector<Finding> takeFindings() override;
private:
    std::string _build_id;
    std::vector<Finding> _findings;
};
} // namespace perf_lens::rules
#endif

#pragma once
#ifdef PERF_LENS_HAVE_LLVM
#include "rules/rule_base.hpp"
namespace perf_lens::rules {
class PromotionFunctionRule final : public Rule {
public:
    const char* id()    const noexcept override { return "perf-lens.constexpr.promotion-function"; }
    const char* title() const noexcept override { return "simple function could be constexpr"; }
    FindingCategory category()   const noexcept override { return FindingCategory::FunctionAttrib; }
    ConfidenceLevel confidence() const noexcept override { return ConfidenceLevel::Low; }
    void registerMatchers(MatchFinder& finder, const std::string& build_id) override;
    std::vector<Finding> takeFindings() override;
private:
    std::string _build_id;
    std::vector<Finding> _findings;
};
} // namespace perf_lens::rules
#endif

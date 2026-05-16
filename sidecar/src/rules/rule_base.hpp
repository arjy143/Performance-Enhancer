#pragma once
#ifdef PERF_LENS_HAVE_LLVM

#include "finding.hpp"
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <string>
#include <vector>

namespace perf_lens::rules {

using MatchFinder = clang::ast_matchers::MatchFinder;

// Abstract base every rule implements.
class Rule {
public:
    virtual ~Rule() = default;

    virtual const char* id()       const noexcept = 0;
    virtual const char* title()    const noexcept = 0;
    virtual FindingCategory category() const noexcept = 0;
    virtual ConfidenceLevel confidence() const noexcept { return ConfidenceLevel::High; }

    // Register AST matchers. Called once at engine startup.
    virtual void registerMatchers(MatchFinder& finder, const std::string& build_id) = 0;

    // Drain any findings accumulated since last call (called after runOnCode).
    virtual std::vector<Finding> takeFindings() = 0;
};

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM

#pragma once
#ifdef PERF_LENS_HAVE_LLVM

#include "finding.hpp"
#include "rule_base.hpp"
#include <memory>
#include <string>
#include <vector>

namespace clang::tooling { class CompilationDatabase; }

namespace perf_lens::rules {

class RuleEngine {
public:
    RuleEngine();

    // Analyse a single file. Returns all findings for that file.
    std::vector<Finding> analyseFile(const std::string& file,
                                     clang::tooling::CompilationDatabase& db,
                                     const std::string& build_id = "analysis");

    // All registered rule IDs.
    std::vector<const char*> ruleIds() const;

private:
    std::vector<std::unique_ptr<Rule>> _rules;
};

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM

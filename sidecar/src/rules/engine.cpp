#ifdef PERF_LENS_HAVE_LLVM

#include "engine.hpp"
#include "ast/translation_unit.hpp"
#include "util/logger.hpp"

// Rule registrations
#include "packs/function_attributes/noexcept_move_ops.hpp"
#include "packs/stl_hygiene/range_for_copy.hpp"
#include "packs/stl_hygiene/endl_flush.hpp"
#include "packs/hotpath/vector_no_reserve.hpp"
#include "packs/hotpath/std_function.hpp"
#include "packs/hotpath/virtual_dispatch.hpp"
#include "packs/memory_layout/padding_detected.hpp"
#include "packs/constexpr/promotion_variable.hpp"
#include "packs/vec/aliasing.hpp"
#include "packs/vec/complex_cf.hpp"
#include "packs/vec/reduction_fp.hpp"
#include "packs/concurrency/mutex_where_atomic.hpp"
#include "packs/hotpath/allocation_in_loop.hpp"
#include "packs/stl_hygiene/nodiscard_return.hpp"
#include "packs/ub/signed_loop_bound.hpp"
#include "packs/memory_layout/cache_line_straddle.hpp"
#include "packs/memory_layout/aos_to_soa.hpp"
#include "packs/constexpr/promotion_function.hpp"
#include "packs/hotpath/shared_ptr_in_loop.hpp"
#include "packs/stl_hygiene/container_copy.hpp"
#include "packs/hotpath/map_in_loop.hpp"
#include "packs/stl_hygiene/string_view_param.hpp"
#include "packs/hotpath/unordered_map_no_reserve.hpp"

#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/Tooling/JSONCompilationDatabase.h>

namespace perf_lens::rules {

RuleEngine::RuleEngine() {
    _rules.push_back(std::make_unique<NoexceptMoveOpsRule>());
    _rules.push_back(std::make_unique<RangeForCopyRule>());
    _rules.push_back(std::make_unique<EndlFlushRule>());
    _rules.push_back(std::make_unique<VectorNoReserveRule>());
    _rules.push_back(std::make_unique<StdFunctionRule>());
    _rules.push_back(std::make_unique<VirtualDispatchInLoopRule>());
    _rules.push_back(std::make_unique<PaddingDetectedRule>());
    _rules.push_back(std::make_unique<PromotionVariableRule>());
    _rules.push_back(std::make_unique<VecAliasingRule>());
    _rules.push_back(std::make_unique<ComplexCfRule>());
    _rules.push_back(std::make_unique<ReductionFpRule>());
    _rules.push_back(std::make_unique<MutexWhereAtomicRule>());
    _rules.push_back(std::make_unique<AllocationInLoopRule>());
    _rules.push_back(std::make_unique<NodiscardReturnRule>());
    _rules.push_back(std::make_unique<SignedLoopBoundRule>());
    _rules.push_back(std::make_unique<CacheLineStraddleRule>());
    _rules.push_back(std::make_unique<AosToSoaRule>());
    _rules.push_back(std::make_unique<PromotionFunctionRule>());
    _rules.push_back(std::make_unique<SharedPtrInLoopRule>());
    _rules.push_back(std::make_unique<ContainerCopyRule>());
    _rules.push_back(std::make_unique<MapInLoopRule>());
    _rules.push_back(std::make_unique<StringViewParamRule>());
    _rules.push_back(std::make_unique<UnorderedMapNoReserveRule>());
}

std::vector<Finding> RuleEngine::analyseFile(
    const std::string& file,
    clang::tooling::CompilationDatabase& db,
    const std::string& build_id)
{
    MatchFinder finder;
    for (auto& rule : _rules)
        rule->registerMatchers(finder, build_id);

    ast::TranslationUnit tu(file, db);
    if (!tu.runMatchers(finder)) {
        Logger::instance().warn("RuleEngine: parse failed for " + file);
        return {};
    }

    std::vector<Finding> all;
    for (auto& rule : _rules) {
        auto found = rule->takeFindings();
        all.insert(all.end(),
                   std::make_move_iterator(found.begin()),
                   std::make_move_iterator(found.end()));
    }
    Logger::instance().info("RuleEngine: " + std::to_string(all.size()) +
                            " findings in " + file);
    return all;
}

std::vector<const char*> RuleEngine::ruleIds() const {
    std::vector<const char*> ids;
    ids.reserve(_rules.size());
    for (const auto& r : _rules) ids.push_back(r->id());
    return ids;
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM

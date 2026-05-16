#include "classifier.hpp"
#include <array>

namespace perf_lens::remarks {
namespace {

struct Entry {
    std::string_view pass_prefix;
    Category         category;
};

// Ordered so longer prefixes match before shorter ones
constexpr std::array<Entry, 16> TABLE{{
    {"loop-vectorize",    Category::Vectorisation},
    {"slp-vectorizer",    Category::Vectorisation},
    {"loop-unroll",       Category::Unrolling},
    {"loop-delete",       Category::LoopTransform},
    {"loop-distribute",   Category::LoopTransform},
    {"loop-interchange",  Category::LoopTransform},
    {"loop-fusion",       Category::LoopTransform},
    {"loop-load-elim",    Category::LoopTransform},
    {"inline",            Category::Inlining},
    {"always-inline",     Category::Inlining},
    {"mandatory-inline",  Category::Inlining},
    {"licm",              Category::Memory},
    {"gvn",               Category::Memory},
    {"memcpyopt",         Category::Memory},
    {"dce",               Category::DeadCode},
    {"adce",              Category::DeadCode},
}};

} // namespace

Category classify(std::string_view pass, [[maybe_unused]] std::string_view name) noexcept {
    for (const auto& e : TABLE) {
        if (pass.starts_with(e.pass_prefix))
            return e.category;
    }
    return Category::Other;
}

} // namespace perf_lens::remarks

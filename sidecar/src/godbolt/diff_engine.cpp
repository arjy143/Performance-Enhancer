#include "diff_engine.hpp"
#include <algorithm>
#include <cctype>
#include <regex>
#include <sstream>

namespace perf_lens::godbolt {

namespace {

bool isInstructionLine(std::string_view line) {
    const auto t = line.find_first_not_of(" \t");
    if (t == std::string_view::npos) return false;
    const auto rest = line.substr(t);
    // Skip directives and labels
    if (rest.empty() || rest[0] == '.') return false;
    if (!rest.empty() && rest.back() == ':') return false;
    return true;
}

// Detect if an instruction uses a vector register class.
bool isVectorInstr(std::string_view instr) {
    return instr.find("xmm") != std::string_view::npos ||
           instr.find("ymm") != std::string_view::npos ||
           instr.find("zmm") != std::string_view::npos ||
           instr.find("vp") != std::string_view::npos ||  // vpaddX etc.
           (instr.size() > 1 && instr[0] == 'v' && std::islower(instr[1]));
}

// LCS table — O(N*M) which is fine for typical function asm sizes (<1000 lines).
std::vector<std::vector<int>> lcsTable(
    const std::vector<std::string>& a,
    const std::vector<std::string>& b,
    const std::vector<std::string>& an,
    const std::vector<std::string>& bn)
{
    const int m = static_cast<int>(a.size());
    const int n = static_cast<int>(b.size());
    std::vector<std::vector<int>> dp(m+1, std::vector<int>(n+1, 0));
    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j)
            dp[i][j] = (an[i-1] == bn[j-1])
                ? dp[i-1][j-1] + 1
                : std::max(dp[i-1][j], dp[i][j-1]);
    return dp;
}

} // namespace

std::vector<std::string> extractInstructions(const std::string& asm_text) {
    std::vector<std::string> out;
    std::istringstream ss{asm_text};
    std::string line;
    while (std::getline(ss, line)) {
        if (isInstructionLine(line)) out.push_back(line);
    }
    return out;
}

std::string normaliseInstruction(const std::string& instr) {
    // Lowercase
    std::string s = instr;
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return std::tolower(c); });

    // Strip register numbers: xmm0-xmm31 → xmm, ymm0-ymm31 → ymm, zmm → zmm
    // Also rax/rbx/rcx/rdx/rsi/rdi/r8-r15 are left as-is (not normalised — they reflect
    // calling convention, not just register allocation noise).
    s = std::regex_replace(s, std::regex(R"(\bxmm\d+\b)"), "XMM");
    s = std::regex_replace(s, std::regex(R"(\bymm\d+\b)"), "YMM");
    s = std::regex_replace(s, std::regex(R"(\bzmm\d+\b)"), "ZMM");

    // Collapse whitespace
    bool inSpace = false;
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == ' ' || c == '\t') {
            if (!inSpace) { out += ' '; inSpace = true; }
        } else {
            inSpace = false;
            out += c;
        }
    }
    // Trim leading/trailing
    while (!out.empty() && out.front() == ' ') out.erase(out.begin());
    while (!out.empty() && out.back()  == ' ') out.pop_back();
    return out;
}

AsmDiff diffInstructions(const std::vector<std::string>& before,
                          const std::vector<std::string>& after,
                          int vector_width_before,
                          int vector_width_after)
{
    AsmDiff result;
    result.instructions_before  = static_cast<int>(before.size());
    result.instructions_after   = static_cast<int>(after.size());
    result.vector_width_before  = vector_width_before;
    result.vector_width_after   = vector_width_after;
    result.vectorisation_improved = vector_width_after > vector_width_before;

    // Normalised versions for comparison
    std::vector<std::string> bn(before.size()), an(after.size());
    for (size_t i = 0; i < before.size(); ++i) bn[i] = normaliseInstruction(before[i]);
    for (size_t i = 0; i < after.size();  ++i) an[i] = normaliseInstruction(after[i]);

    const int m = static_cast<int>(before.size());
    const int n = static_cast<int>(after.size());
    auto dp = lcsTable(before, after, bn, an);

    // Backtrack through LCS to build diff
    std::vector<InstructionDiff> changes;
    int i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && bn[i-1] == an[j-1]) {
            InstructionDiff d;
            d.kind = InstructionDiff::Kind::Unchanged;
            d.before_text = before[i-1];
            d.after_text  = after[j-1];
            changes.push_back(d);
            --i; --j;
        } else if (j > 0 && (i == 0 || dp[i][j-1] >= dp[i-1][j])) {
            InstructionDiff d;
            d.kind = InstructionDiff::Kind::Added;
            d.after_text = after[j-1];
            // Categorise
            const bool is_vec = isVectorInstr(an[j-1]);
            d.category = is_vec ? "vectorised" : "";
            changes.push_back(d);
            --j;
        } else {
            InstructionDiff d;
            d.kind = InstructionDiff::Kind::Removed;
            d.before_text = before[i-1];
            // If removed instruction was scalar and after we have vectorised, mark it
            const bool was_scalar = !isVectorInstr(bn[i-1]);
            d.category = (was_scalar && result.vectorisation_improved) ? "eliminated" : "";
            changes.push_back(d);
            --i;
        }
    }
    std::reverse(changes.begin(), changes.end());
    result.changes = std::move(changes);

    // Build human summary
    int added = 0, removed = 0;
    for (const auto& c : result.changes) {
        if (c.kind == InstructionDiff::Kind::Added)   ++added;
        if (c.kind == InstructionDiff::Kind::Removed) ++removed;
    }
    const int net = result.instructions_after - result.instructions_before;

    std::ostringstream summ;
    if (result.vectorisation_improved) {
        summ << "Vector width: " << vector_width_before << "x to " << vector_width_after << "x";
        if (net != 0) summ << "; instructions: " << (net > 0 ? "+" : "") << net;
    } else {
        summ << "Instructions: " << (net >= 0 ? "+" : "") << net;
        if (added > 0)   summ << " (" << added << " added";
        if (removed > 0) summ << (added > 0 ? ", " : " (") << removed << " removed";
        if (added > 0 || removed > 0) summ << ")";
    }
    result.summary = summ.str();
    return result;
}

} // namespace perf_lens::godbolt

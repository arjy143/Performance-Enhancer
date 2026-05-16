// perf-lens.stl.range-for-copy — should NOT fire
#include <vector>
#include <string>

void process(const std::vector<std::string>& v) {
    for (const auto& s : v) { (void)s; }  // reference — no copy
}

void ints(const std::vector<int>& v) {
    for (auto i : v) { (void)i; }  // trivially copyable — fine
}

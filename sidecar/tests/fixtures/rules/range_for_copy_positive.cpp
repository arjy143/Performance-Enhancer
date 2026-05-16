// perf-lens.stl.range-for-copy — should FIRE
#include <vector>
#include <string>

void process(const std::vector<std::string>& v) {
    for (auto s : v) {   // copies std::string on each iteration
        (void)s;
    }
}

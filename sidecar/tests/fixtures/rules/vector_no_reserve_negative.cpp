// perf-lens.hotpath.vector-no-reserve — should NOT fire
#include <vector>

std::vector<int> build(int n) {
    std::vector<int> v;
    v.reserve(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        v.push_back(i);   // reserve called — fine
    return v;
}

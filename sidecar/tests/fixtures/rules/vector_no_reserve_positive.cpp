// perf-lens.hotpath.vector-no-reserve — should FIRE
#include <vector>

std::vector<int> build(int n) {
    std::vector<int> v;
    for (int i = 0; i < n; ++i)
        v.push_back(i);   // no reserve before loop
    return v;
}

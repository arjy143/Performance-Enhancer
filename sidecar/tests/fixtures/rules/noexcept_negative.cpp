// perf-lens.noexcept.move-ops — should NOT fire
struct Good {
    int x;
    Good(Good&&) noexcept = default;
    Good& operator=(Good&&) noexcept = default;
};

struct AlsoGood {
    int data[64];
    AlsoGood(AlsoGood&& other) noexcept {
        for (int i = 0; i < 64; ++i) data[i] = other.data[i];
    }
    AlsoGood& operator=(AlsoGood&& other) noexcept {
        for (int i = 0; i < 64; ++i) data[i] = other.data[i];
        return *this;
    }
};

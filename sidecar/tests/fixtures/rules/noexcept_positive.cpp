// perf-lens.noexcept.move-ops — should FIRE
struct BigObj {
    int data[64];

    BigObj(BigObj&& other) {            // missing noexcept
        for (int i = 0; i < 64; ++i) data[i] = other.data[i];
    }

    BigObj& operator=(BigObj&& other) { // missing noexcept
        for (int i = 0; i < 64; ++i) data[i] = other.data[i];
        return *this;
    }
};

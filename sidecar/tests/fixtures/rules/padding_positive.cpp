// perf-lens.padding.detected — should FIRE
struct Wasteful {
    char  a;    // 1 byte
    // 7 bytes padding
    double b;   // 8 bytes
    int   c;    // 4 bytes
    // 4 bytes padding (to align to 8)
    // sizeof == 24, packed == 13 → 11 bytes wasted
};

// perf-lens.padding.detected — should NOT fire
struct Packed {
    double a;   // 8 bytes (largest first)
    int    b;   // 4 bytes
    short  c;   // 2 bytes
    char   d;   // 1 byte
    char   e;   // 1 byte
    // sizeof == 16, packed == 16 → no waste
};

fn main() {
    prost_build::Config::new()
        .out_dir("src")
        .compile_protos(&["proto/profile.proto"], &["proto/"])
        .expect("prost_build failed");
}

//! pprof-importer — converts pprof .pb / .pb.gz files to NDJSON.
//!
//! Usage:
//!   pprof-importer <profile.pb.gz> [--label <name>]

#![deny(warnings)]

include!(concat!(env!("OUT_DIR"), "/perftools.profiles.rs"));

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use prost::Message;
use serde_json::{json, Value};

fn emit(j: Value) {
    let s = serde_json::to_string(&j).unwrap_or_default();
    println!("{s}");
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn read_file(path: &str) -> io::Result<Vec<u8>> {
    let raw = fs::read(path)?;
    // Detect gzip by magic bytes
    if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut decoder = GzDecoder::new(&raw[..]);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(raw)
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut input_path = String::new();
    let mut label      = String::from("pprof profile");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--label" | "-l" => { i += 1; if i < args.len() { label = args[i].clone(); } }
            "--help"  | "-h" => { eprintln!("Usage: pprof-importer <file.pb.gz> [--label name]"); process::exit(0); }
            arg if !arg.starts_with('-') => { input_path = arg.to_owned(); }
            _ => {}
        }
        i += 1;
    }

    if input_path.is_empty() {
        eprintln!("error: no input file specified");
        process::exit(1);
    }

    let bytes = match read_file(&input_path) {
        Ok(b) => b,
        Err(e) => { eprintln!("error reading {input_path}: {e}"); process::exit(1); }
    };

    let profile = match Profile::decode(bytes.as_slice()) {
        Ok(p) => p,
        Err(e) => { eprintln!("error decoding protobuf: {e}"); process::exit(1); }
    };

    // Build string table (index 0 is always empty string in pprof)
    // NB: in pprof, string_table field is actually repeated string (string_table)
    // In our proto definition we used int64 which is wrong — the field is bytes/string.
    // Since prost-build will generate the type from our proto, let's just work around
    // by reading raw field 6. But actually, let's use the proper approach.
    // The pprof proto's string_table is field 6, type repeated string.
    // Our simplified proto has it wrong. We'll read it via the raw decoded struct.
    // For simplicity, rebuild with a corrected approach.

    // Since our proto has string_table as repeated int64 (wrong), let's fall back to
    // direct field access which prost gives us.
    // Actually Profile.string_table will be Vec<i64> per our proto — not useful.
    // Instead, re-parse the raw bytes manually for field 6.
    let strings = extract_string_table(&bytes);

    let str = |idx: i64| -> &str {
        if idx < 0 { return ""; }
        strings.get(idx as usize).map(|s| s.as_str()).unwrap_or("")
    };

    // Determine sample type name (usually first sample_type is "samples"/"cpu")
    let sample_type_name = profile.sample_type.first()
        .map(|st| str(st.r#type))
        .unwrap_or("cycles");

    // Build location → function map
    let func_map: HashMap<u64, &Function> = profile.function.iter().map(|f| (f.id, f)).collect();
    let loc_map:  HashMap<u64, &Location> = profile.location.iter().map(|l| (l.id, l)).collect();

    // Aggregate hotness
    let mut line_hot:  HashMap<(String, u32), u64> = HashMap::new();
    let mut func_hot:  HashMap<String, (u64, String)> = HashMap::new();
    let mut total_samples: u64 = 0;

    for sample in &profile.sample {
        let value = sample.value.first().copied().unwrap_or(1) as u64;
        total_samples += value;

        // Leaf = first location, first line
        if let Some(&loc_id) = sample.location_id.first() {
            if let Some(loc) = loc_map.get(&loc_id) {
                if let Some(line_ref) = loc.line.first() {
                    if let Some(func) = func_map.get(&line_ref.function_id) {
                        let fname = str(func.name).to_owned();
                        let ffile = str(func.filename).to_owned();
                        let fline = line_ref.line as u32;

                        if !ffile.is_empty() && fline > 0 {
                            *line_hot.entry((ffile.clone(), fline)).or_default() += value;
                        }
                        if !fname.is_empty() {
                            let e = func_hot.entry(fname).or_insert((0, ffile));
                            e.0 += value;
                        }
                    }
                }
            }
        }
    }

    let duration_ms = profile.duration_nanos / 1_000_000;

    emit(json!({
        "type":            "metadata",
        "id":              "",
        "label":           label,
        "recorded_at":     unix_now(),
        "duration_ms":     duration_ms,
        "source_profiler": "pprof",
        "total_samples":   total_samples,
    }));

    for ((file, line), count) in &line_hot {
        emit(json!({
            "type":  "line",
            "event": sample_type_name,
            "file":  file,
            "line":  line,
            "self":  count,
        }));
    }

    for (func, (count, file)) in &func_hot {
        emit(json!({
            "type":     "function",
            "event":    sample_type_name,
            "function": func,
            "file":     file,
            "self":     count,
        }));
    }

    io::stdout().flush().ok();
}

// Extract string_table (field 6, wire type 2 = LEN) directly from raw bytes.
// This bypasses our incorrect proto definition (we declared it as int64).
fn extract_string_table(bytes: &[u8]) -> Vec<String> {
    let mut strings: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Read varint tag
        let (tag, n) = decode_varint(bytes, i);
        if n == 0 { break; }
        i += n;
        let field_num = tag >> 3;
        let wire_type = tag & 0x7;

        if field_num == 6 && wire_type == 2 {
            // LEN: read length then bytes
            let (len, n2) = decode_varint(bytes, i);
            if n2 == 0 { break; }
            i += n2;
            let len = len as usize;
            if i + len > bytes.len() { break; }
            let s = String::from_utf8_lossy(&bytes[i..i+len]).into_owned();
            strings.push(s);
            i += len;
        } else {
            // Skip field
            match wire_type {
                0 => { let (_, n) = decode_varint(bytes, i); if n == 0 { break; } i += n; }
                1 => { i += 8; }
                2 => {
                    let (len, n) = decode_varint(bytes, i);
                    if n == 0 { break; }
                    i += n + len as usize;
                }
                5 => { i += 4; }
                _ => break,
            }
        }
    }
    strings
}

fn decode_varint(bytes: &[u8], start: usize) -> (u64, usize) {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut i = start;
    loop {
        if i >= bytes.len() { return (0, 0); }
        let b = bytes[i] as u64;
        i += 1;
        result |= (b & 0x7f) << shift;
        if b & 0x80 == 0 { break; }
        shift += 7;
        if shift >= 64 { return (0, 0); }
    }
    (result, i - start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_varint_single_byte() {
        assert_eq!((5, 1), decode_varint(&[5], 0));
    }

    #[test]
    fn decode_varint_two_bytes() {
        // 300 = 0xAC 0x02
        assert_eq!((300, 2), decode_varint(&[0xAC, 0x02], 0));
    }

    #[test]
    fn extract_empty_string_table() {
        let strings = extract_string_table(&[]);
        assert!(strings.is_empty());
    }
}

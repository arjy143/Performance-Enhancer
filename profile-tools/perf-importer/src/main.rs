//! perf-importer — converts `perf script` text output to NDJSON.
//!
//! Usage:
//!   perf script [options] | perf-importer [--label <name>]
//!   perf-importer --file perf.data [--label <name>]
//!
//! Output (NDJSON, one JSON object per line):
//!   Line 1: {"type":"metadata",...}
//!   Subsequent: {"type":"line","event":"cycles","file":"...","line":N,"self":M}
//!                {"type":"function","event":"cycles","function":"...","file":"...","self":M}

#![deny(warnings)]

use std::collections::HashMap;
use std::env;
use std::io::{self, BufRead, Write};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

// ── Aggregated counts ─────────────────────────────────────────────────────

#[derive(Default)]
struct Counts {
    self_count: u64,
}

type LineKey   = (String /* event */, String /* file */, u32 /* line */);
type FuncKey   = (String /* event */, String /* function */);

struct Aggregator {
    line_counts: HashMap<LineKey, Counts>,
    func_counts: HashMap<FuncKey, (Counts, String /* file */)>,
    total_samples: u64,
    first_timestamp: f64,
    last_timestamp:  f64,
}

impl Aggregator {
    fn new() -> Self {
        Aggregator {
            line_counts:     HashMap::new(),
            func_counts:     HashMap::new(),
            total_samples:   0,
            first_timestamp: 0.0,
            last_timestamp:  0.0,
        }
    }

    fn record_sample(&mut self, event: &str, count: u64, timestamp: f64, frames: &[Frame]) {
        self.total_samples += 1;
        if self.first_timestamp == 0.0 { self.first_timestamp = timestamp; }
        self.last_timestamp = timestamp;

        // Leaf frame → self
        if let Some(leaf) = frames.first() {
            if !leaf.file.is_empty() && leaf.line > 0 {
                let key = (event.to_owned(), leaf.file.clone(), leaf.line);
                self.line_counts.entry(key).or_default().self_count += count;
            }
            if !leaf.function.is_empty() {
                let key = (event.to_owned(), leaf.function.clone());
                let entry = self.func_counts.entry(key).or_insert_with(|| {
                    (Counts::default(), leaf.file.clone())
                });
                entry.0.self_count += count;
            }
        }
    }
}

// ── perf script parser ────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct Frame {
    address:  u64,
    function: String,
    file:     String,
    line:     u32,
    module:   String,
}

struct PerfScriptParser {
    current_event:     String,
    current_count:     u64,
    current_timestamp: f64,
    current_frames:    Vec<Frame>,
    in_sample:         bool,
}

impl PerfScriptParser {
    fn new() -> Self {
        PerfScriptParser {
            current_event:     String::new(),
            current_count:     1,
            current_timestamp: 0.0,
            current_frames:    Vec::new(),
            in_sample:         false,
        }
    }

    // Parse a header line like:
    //   bench 1234 [001] 12345.678: 99 cycles:u:
    //   bench 1234 12345.678: 99 cycles:u:
    fn parse_header(&mut self, line: &str) -> bool {
        // Find the colon-terminated event name near the end
        // Strategy: work backwards from the colon after the event name
        // Format after timestamp field: `<count> <event>:`
        // Find last `: ` or `:` that ends the event field
        let parts: Vec<&str> = line.splitn(2, ':').collect();
        if parts.len() < 2 { return false; }

        // After the first colon we expect: " <count> <event>:"
        // But there may be multiple colons (e.g. timestamp has one)
        // Use a regex-free approach: find the last occurrence of a digit-then-space-then-word-then-colon
        // Simpler: split on whitespace and look for the pattern
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Find `<number> <event-name>:` near the end
        // The event token ends with ':'
        let mut event_idx = None;
        for (i, tok) in tokens.iter().enumerate().rev() {
            if tok.ends_with(':') && i > 0 {
                // Previous token should be a sample count (number)
                if tokens[i-1].parse::<u64>().is_ok() {
                    event_idx = Some((i, i-1));
                    break;
                }
            }
        }
        let (ev_i, count_i) = event_idx?;
        self.current_event = tokens[ev_i].trim_end_matches(':').to_owned();
        self.current_count = tokens[count_i].parse().unwrap_or(1);

        // Extract timestamp — find a token that looks like `1234567.890:`
        for tok in &tokens {
            let t = tok.trim_end_matches(':');
            if t.contains('.') {
                if let Ok(f) = t.parse::<f64>() {
                    if f > 1_000.0 {   // plausible timestamp
                        self.current_timestamp = f;
                        break;
                    }
                }
            }
        }

        true
    }

    // Parse a frame line (leading whitespace):
    //   \t  7fff1234 symbol+0x10 (/lib/foo.so)
    //   \t  7fff1234 symbol+0x10 (/lib/foo.so) [src/file.cpp:42]
    fn parse_frame(&self, line: &str) -> Option<Frame> {
        let trimmed = line.trim();
        if trimmed.is_empty() { return None; }

        let mut parts = trimmed.splitn(3, ' ');
        let addr_str  = parts.next()?;
        let sym_part  = parts.next().unwrap_or("");
        let rest      = parts.next().unwrap_or("");

        let address = u64::from_str_radix(addr_str.trim_start_matches("0x"), 16).unwrap_or(0);

        // Symbol: may be "func+0x10" or just "func"
        let function = sym_part.split('+').next().unwrap_or(sym_part)
                               .trim_start_matches('[').to_owned();

        // Module: inside first set of parens
        let module = rest.split('(').nth(1)
                         .and_then(|s| s.split(')').next())
                         .unwrap_or("").to_owned();

        // srcline: inside square brackets at end — "[file.cpp:42]"
        let (file, line_num) = if let Some(bracket) = rest.rfind('[') {
            let inner = rest[bracket+1..].split(']').next().unwrap_or("");
            if let Some(colon) = inner.rfind(':') {
                let f = inner[..colon].to_owned();
                let l = inner[colon+1..].parse::<u32>().unwrap_or(0);
                (f, l)
            } else { (String::new(), 0) }
        } else { (String::new(), 0) };

        Some(Frame { address, function, file, line: line_num, module })
    }

    // Feed one line; returns a completed sample if one was just finished.
    fn feed<'a>(&mut self, line: &str) -> Option<(String, u64, f64, Vec<Frame>)> {
        let is_frame = line.starts_with('\t') || (line.starts_with(' ') && !line.trim().is_empty());

        if is_frame && self.in_sample {
            if let Some(f) = self.parse_frame(line) {
                self.current_frames.push(f);
            }
            return None;
        }

        // Flush pending sample before starting new header
        let finished = if self.in_sample && !self.current_frames.is_empty() {
            Some((
                self.current_event.clone(),
                self.current_count,
                self.current_timestamp,
                std::mem::take(&mut self.current_frames),
            ))
        } else {
            None
        };

        // Try parsing as a new header
        if !line.trim().is_empty() && !is_frame {
            self.current_frames.clear();
            if self.parse_header(line) {
                self.in_sample = true;
            } else {
                self.in_sample = false;
            }
        }

        finished
    }

    fn flush(&mut self) -> Option<(String, u64, f64, Vec<Frame>)> {
        if self.in_sample && !self.current_frames.is_empty() {
            self.in_sample = false;
            Some((
                self.current_event.clone(),
                self.current_count,
                self.current_timestamp,
                std::mem::take(&mut self.current_frames),
            ))
        } else {
            None
        }
    }
}

// ── Output helpers ────────────────────────────────────────────────────────

fn emit(j: Value) {
    let s = serde_json::to_string(&j).unwrap_or_default();
    println!("{s}");
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

// ── main ──────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut label  = String::from("perf profile");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--label" | "-l" => {
                i += 1;
                if i < args.len() { label = args[i].clone(); }
            }
            "--help" | "-h" => {
                eprintln!("Usage: perf script | perf-importer [--label <name>]");
                process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    let stdin  = io::stdin();
    let mut agg    = Aggregator::new();
    let mut parser = PerfScriptParser::new();

    for raw_line in stdin.lock().lines() {
        let line = match raw_line {
            Ok(l) => l,
            Err(_) => break,
        };
        if let Some((event, count, ts, frames)) = parser.feed(&line) {
            agg.record_sample(&event, count, ts, &frames);
        }
    }
    if let Some((event, count, ts, frames)) = parser.flush() {
        agg.record_sample(&event, count, ts, &frames);
    }

    // ── Emit NDJSON ────────────────────────────────────────────────────────

    let duration_ms = if agg.last_timestamp > agg.first_timestamp {
        ((agg.last_timestamp - agg.first_timestamp) * 1000.0) as i64
    } else { 0 };

    emit(json!({
        "type":           "metadata",
        "id":             "",
        "label":          label,
        "recorded_at":    unix_now(),
        "duration_ms":    duration_ms,
        "source_profiler":"perf",
        "total_samples":  agg.total_samples,
    }));

    for ((event, file, line), counts) in &agg.line_counts {
        emit(json!({
            "type":  "line",
            "event": event,
            "file":  file,
            "line":  line,
            "self":  counts.self_count,
        }));
    }

    for ((event, function), (counts, file)) in &agg.func_counts {
        emit(json!({
            "type":     "function",
            "event":    event,
            "function": function,
            "file":     file,
            "self":     counts.self_count,
        }));
    }

    io::stdout().flush().ok();
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_header_cycles() {
        let mut p = PerfScriptParser::new();
        let ok = p.parse_header("bench 1234 [000] 98765.123456:   999 cycles:u:");
        assert!(ok, "should parse header");
        assert_eq!("cycles:u", p.current_event);
        assert_eq!(999, p.current_count);
    }

    #[test]
    fn parse_header_no_cpu_field() {
        let mut p = PerfScriptParser::new();
        let ok = p.parse_header("bench 1234 98765.123456:   1 cycles:");
        assert!(ok);
        assert_eq!("cycles", p.current_event);
    }

    #[test]
    fn parse_frame_with_srcline() {
        let p = PerfScriptParser::new();
        let f = p.parse_frame("\t  7ffe1234 integrate+0x48 (/bin/bench) [/src/sim.cpp:42]");
        let f = f.expect("should parse frame");
        assert_eq!("integrate", f.function);
        assert_eq!("/src/sim.cpp", f.file);
        assert_eq!(42, f.line);
        assert_eq!("/bin/bench", f.module);
    }

    #[test]
    fn parse_frame_without_srcline() {
        let p = PerfScriptParser::new();
        let f = p.parse_frame("\t  7ffe1234 main+0x0 (/bin/bench)");
        let f = f.expect("should parse frame");
        assert_eq!("main", f.function);
        assert_eq!("", f.file);
        assert_eq!(0, f.line);
    }

    #[test]
    fn aggregator_counts_self() {
        let mut agg = Aggregator::new();
        let frames = vec![
            Frame { function: "leaf".into(), file: "/a.cpp".into(), line: 10, ..Frame::default() },
            Frame { function: "caller".into(), file: "/b.cpp".into(), line: 20, ..Frame::default() },
        ];
        agg.record_sample("cycles", 1, 1.0, &frames);

        let k = ("cycles".to_owned(), "/a.cpp".to_owned(), 10u32);
        assert_eq!(1, agg.line_counts[&k].self_count);

        let k2 = ("cycles".to_owned(), "/b.cpp".to_owned(), 20u32);
        assert!(!agg.line_counts.contains_key(&k2), "caller should not be in self counts");
    }

    #[test]
    fn full_parse_two_samples() {
        let input = concat!(
            "bench 1 [0] 1.0:  1 cycles:\n",
            "\t 100 leaf+0x0 (/bin/bench) [/src/hot.cpp:5]\n",
            "\t 200 main+0x0 (/bin/bench)\n",
            "\n",
            "bench 1 [0] 2.0:  1 cycles:\n",
            "\t 100 leaf+0x0 (/bin/bench) [/src/hot.cpp:5]\n",
            "\n",
        );
        let mut agg = Aggregator::new();
        let mut parser = PerfScriptParser::new();
        for line in input.lines() {
            if let Some((ev, cnt, ts, frames)) = parser.feed(line) {
                agg.record_sample(&ev, cnt, ts, &frames);
            }
        }
        if let Some((ev, cnt, ts, frames)) = parser.flush() {
            agg.record_sample(&ev, cnt, ts, &frames);
        }

        let k = ("cycles".to_owned(), "/src/hot.cpp".to_owned(), 5u32);
        assert_eq!(2, agg.line_counts[&k].self_count);
        assert_eq!(2, agg.total_samples);
    }
}

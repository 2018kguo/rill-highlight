//! The doubling probe behind tests/doubling.rs, over every bundled language:
//! `cargo run --release --features op-counts --example doubling_probe -- js/dist [LANG...]`
//! prints each (language, input family) whose tokenizing work grows faster than
//! 2.6x per doubling from 1k to 8k code units, with its operation counts and times.
//! `RHL_FAMILY` limits it to one family, `RHL_SIZES` (e.g. `2048,4096`) sets the sizes.
//! Compare what it prints with Shiki before calling a growth ours: many grammars'
//! patterns backtrack quadratically in V8 too.
use rill_highlight::{Highlighter, ops};
use serde_json::Value;
use std::time::Instant;

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn repeat(unit: &str, n: usize) -> String {
    unit.repeat(n / unit.len() + 1)[..n].to_string()
}

const FAMILIES: &[&str] = &[
    "list",
    "ident",
    "spaces",
    "unclosed-dq",
    "unclosed-sq",
    "parens",
    "brackets",
    "backslashes",
    "tags",
    "comments",
    "punct",
    "numbers",
    "calls",
    "vars",
    "hashes",
    "quotes",
    "lines",
    "nest-lines",
    "quote-lines",
];

/// The families of tests/doubling.rs, plus `nest-lines` (one `{` per line).
fn family(name: &str, n: usize) -> String {
    match name {
        "list" => repeat("\"x\", 1, ", n),
        "ident" => repeat("a", n),
        "spaces" => format!("{}x", " ".repeat(n)),
        "unclosed-dq" => format!("\"{}", "ab ".repeat(n / 3)),
        "unclosed-sq" => format!("'{}", "ab ".repeat(n / 3)),
        "parens" => repeat("(", n),
        "brackets" => repeat("[{(<", n),
        "backslashes" => repeat("\\", n),
        "tags" => repeat("<a ", n),
        "comments" => repeat("/*", n),
        "punct" => repeat("!@#$%^&*()_+-=[]{};:'\",.<>/?|~`", n),
        "numbers" => repeat("0x1F 1.5e10 ", n),
        "calls" => repeat("a.b(c) ", n),
        "vars" => repeat("$x ", n),
        "hashes" => repeat("#", n),
        "quotes" => repeat("\"'`", n),
        "lines" => "let x = foo(1, \"a\") + bar[2]; // c\n".repeat(n / 36 + 1),
        "nest-lines" => "{\n".repeat(n / 2),
        "quote-lines" => "\"\n".repeat(n / 2),
        _ => unreachable!("family {name}"),
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let data = &arguments[1];
    let wanted = &arguments[2..];
    let sizes: Vec<usize> =
        std::env::var("RHL_SIZES").map_or(vec![1024, 2048, 4096, 8192], |sizes| sizes.split(',').map(|n| n.parse().expect("size")).collect());
    let only = std::env::var("RHL_FAMILY").ok();
    let languages: Value = serde_json::from_str(&read(&format!("{data}/languages.json"))).expect("languages.json");
    let light = read(&format!("{data}/themes/github-light.json"));
    let dark = read(&format!("{data}/themes/github-dark.json"));
    let mut seen = std::collections::HashSet::new();
    for (id, entry) in languages.as_object().expect("object") {
        let name = entry["name"].as_str().expect("name");
        if (!wanted.is_empty() && !wanted.contains(id)) || !seen.insert(name.to_string()) {
            continue;
        }
        let grammars: Vec<String> =
            entry["grammars"].as_array().expect("grammars").iter().map(|g| read(&format!("{data}/grammars/{}.json", g.as_str().expect("name")))).collect();
        let grammars: Vec<&str> = grammars.iter().map(String::as_str).collect();
        let Ok(mut highlighter) = Highlighter::from_json(&grammars, name, &[&light, &dark]) else {
            eprintln!("{name}: no highlighter");
            continue;
        };
        for &family_name in FAMILIES.iter().filter(|&&f| only.as_deref().is_none_or(|only| only == f)) {
            let (mut counts, mut times) = (Vec::new(), Vec::new());
            for &size in &sizes {
                let code: Vec<u16> = family(family_name, size).encode_utf16().collect();
                let (before, start) = (ops::operations(), Instant::now());
                if highlighter.tokenize(&code, None, 0).is_err() {
                    break;
                }
                times.push((start.elapsed().as_secs_f64() * 10_000.0).round() / 10.0);
                counts.push(ops::operations() - before);
                // Stop before a superlinear family takes minutes.
                if start.elapsed().as_secs_f64() > 1.5 {
                    break;
                }
            }
            let ratios: Vec<f64> = counts.windows(2).map(|pair| (pair[1] as f64 / pair[0].max(1) as f64 * 100.0).round() / 100.0).collect();
            if ratios.iter().skip(1).any(|&ratio| ratio > 2.6) || counts.len() < sizes.len() {
                println!("{name}\t{family_name}\tops={counts:?}\tratios={ratios:?}\tms={times:?}");
            }
        }
    }
}

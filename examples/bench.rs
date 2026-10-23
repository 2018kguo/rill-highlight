//! `cargo run --release --example bench -- DATA_DIR LANG FILE...`: prints JSON with
//! the cold time (load the grammars and the github-light/github-dark themes, then
//! tokenize once) and the warm time of tokenizing the files (concatenated) from
//! the initial state.
use rill_highlight::Highlighter;
use serde_json::{Value, json};
use std::time::Instant;

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let [_, data, language, files @ ..] = arguments.as_slice() else {
        panic!("usage: bench DATA_DIR LANG FILE...");
    };
    let code: Vec<u16> = files.iter().map(|path| read(path)).collect::<Vec<_>>().join("\n").encode_utf16().collect();
    let start = Instant::now();
    let languages: Value = serde_json::from_str(&read(&format!("{data}/languages.json"))).expect("languages.json");
    let entry = &languages[language.as_str()];
    let grammar_names = entry["grammars"].as_array().expect("grammars");
    let grammars: Vec<String> = grammar_names.iter().map(|name| read(&format!("{data}/grammars/{}.json", name.as_str().expect("name")))).collect();
    let grammars: Vec<&str> = grammars.iter().map(String::as_str).collect();
    let light = read(&format!("{data}/themes/github-light.json"));
    let dark = read(&format!("{data}/themes/github-dark.json"));
    let load_start = Instant::now();
    let mut highlighter = Highlighter::from_json(&grammars, entry["name"].as_str().expect("name"), &[&light, &dark]).expect("highlighter");
    let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
    highlighter.tokenize(&code, None, 0).expect("tokenize");
    let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
    let executions_before = highlighter.regex_executions();
    highlighter.tokenize(&code, None, 0).expect("tokenize");
    let executions = highlighter.regex_executions() - executions_before;
    // The minimum of several runs: the machine may be shared.
    let mut warm_ms = f64::MAX;
    for _ in 0..9 {
        let run = Instant::now();
        std::hint::black_box(highlighter.tokenize(&code, None, 0).expect("tokenize"));
        warm_ms = warm_ms.min(run.elapsed().as_secs_f64() * 1000.0);
    }
    println!("{}", json!({ "lang": language, "loadMs": load_ms, "coldMs": cold_ms, "warmMs": warm_ms, "execs": executions }));
}

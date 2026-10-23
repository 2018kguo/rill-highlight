//! Doubling tests: the work to tokenize grows linearly with the input. Each input
//! family is tokenized at n, 2n and 4n code units and the operations the regex VM
//! and the tokenizer count (`op-counts` feature, see src/ops.rs) must grow at most
//! 2.5x per doubling. Counting operations instead of timing keeps the tests exact
//! on a shared CI machine.
//!
//! Some grammars' own patterns backtrack quadratically on some inputs, in Shiki
//! (V8) exactly as here: those pairs, listed in `QUADRATIC_IN_SHIKI` (measured
//! against Shiki 4.5.0 on its JavaScript engine), must stay within 4.5x per
//! doubling, so a regression to worse than quadratic still fails.
//!
//! `cargo test --release --features op-counts --test doubling` (needs the data
//! build in js/dist, see tests/grammars.rs).
#![cfg(feature = "op-counts")]

use rill_highlight::{Highlighter, ops};
use serde_json::Value;
use std::path::Path;

const LANGUAGES: &[&str] = &[
    "typescript",
    "javascript",
    "tsx",
    "python",
    "rust",
    "go",
    "java",
    "c",
    "cpp",
    "csharp",
    "shellscript",
    "json",
    "yaml",
    "html",
    "css",
    "markdown",
    "sql",
    "ruby",
    "php",
    "kotlin",
    "swift",
    "lua",
    "toml",
    "diff",
];

/// (language, family) pairs whose work Shiki also grows quadratically.
const QUADRATIC_IN_SHIKI: &[(&str, &str)] = &[
    ("rust", "ident"),
    ("java", "ident"),
    ("csharp", "ident"),
    ("shellscript", "ident"),
    ("typescript", "spaces"),
    ("javascript", "spaces"),
    ("tsx", "spaces"),
    ("java", "spaces"),
    ("cpp", "spaces"),
    ("csharp", "spaces"),
    ("shellscript", "spaces"),
    ("java", "unclosed-dq"),
    ("java", "unclosed-sq"),
    ("shellscript", "backslashes"),
    ("shellscript", "comments"),
    ("css", "comments"),
    ("css", "calls"),
    ("swift", "hashes"),
    ("shellscript", "quotes"),
];

fn repeat(unit: &str, n: usize) -> String {
    unit.repeat(n / unit.len() + 1)[..n].to_string()
}

/// Input families: one long line each, or many lines.
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
        "quote-lines" => "\"\n".repeat(n / 2),
        _ => unreachable!("family {name}"),
    }
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
    "quote-lines",
];

struct Data {
    directory: std::path::PathBuf,
    languages: Value,
    themes: [String; 2],
}

fn data() -> Option<Data> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("js/dist");
    let read = |path: &str| std::fs::read_to_string(directory.join(path)).ok();
    let languages = serde_json::from_str(&read("languages.json")?).expect("languages.json");
    let themes = [read("themes/github-light.json")?, read("themes/github-dark.json")?];
    Some(Data { directory, languages, themes })
}

fn highlighter(data: &Data, language: &str) -> Highlighter {
    let entry = &data.languages[language];
    let grammars: Vec<String> = entry["grammars"]
        .as_array()
        .expect("grammars")
        .iter()
        .map(|name| std::fs::read_to_string(data.directory.join(format!("grammars/{}.json", name.as_str().expect("name")))).expect("grammar file"))
        .collect();
    let grammars: Vec<&str> = grammars.iter().map(String::as_str).collect();
    Highlighter::from_json(&grammars, entry["name"].as_str().expect("name"), &[&data.themes[0], &data.themes[1]]).expect("highlighter")
}

/// The operations to tokenize `code` from the initial state.
fn operations(highlighter: &mut Highlighter, code: &str) -> u64 {
    let code: Vec<u16> = code.encode_utf16().collect();
    let before = ops::operations();
    highlighter.tokenize(&code, None, 0).expect("tokenize");
    ops::operations() - before
}

/// The growth per doubling of `build`'s work at n, 2n, 4n (the worst of the two).
fn growth(highlighter: &mut Highlighter, build: impl Fn(usize) -> String) -> (f64, Vec<u64>) {
    let counts: Vec<u64> = [1024, 2048, 4096].iter().map(|&n| operations(highlighter, &build(n))).collect();
    let worst = counts.windows(2).map(|pair| pair[1] as f64 / pair[0].max(1) as f64).fold(0.0, f64::max);
    (worst, counts)
}

#[test]
fn tokenizing_grows_linearly() {
    let Some(data) = data() else {
        eprintln!("skipped: no js/dist (run `npm run build` in js/)");
        return;
    };
    let mut failures = Vec::new();
    for &language in LANGUAGES {
        let mut highlighter = highlighter(&data, language);
        for &name in FAMILIES {
            let (worst, counts) = growth(&mut highlighter, |n| family(name, n));
            let bound = if QUADRATIC_IN_SHIKI.contains(&(language, name)) { 4.5 } else { 2.5 };
            if worst > bound {
                failures.push(format!("{language} {name}: {worst:.2}x per doubling (bound {bound}), operations {counts:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "work grows faster than the input:\n{}", failures.join("\n"));
}

#[test]
fn retokenized_captures_do_not_copy_the_line() {
    // C numbers retokenize their captures (a sub-line up to the capture's end): a
    // line of many numbers was quadratic while each capture copied the line.
    let Some(data) = data() else { return };
    for language in ["c", "cpp", "go", "csharp"] {
        let (worst, counts) = growth(&mut highlighter(&data, language), |n| repeat("0x1F 1.5e10 ", n));
        assert!(worst <= 2.5, "{language}: {worst:.2}x per doubling, operations {counts:?}");
    }
}

#[test]
fn lookbehinds_wait_for_what_follows_them() {
    // ahk: `\b(?<=\bGui\b\s*,?\s*((\w+|%\w+%):\s*)?Show\s*,[^,]*)(Center|xCenter|...)\b`
    // scanned back through the line at every word boundary followed by an `x`.
    let Some(data) = data() else { return };
    let (worst, counts) = growth(&mut highlighter(&data, "ahk"), |n| repeat("$x ", n));
    assert!(worst <= 2.5, "{worst:.2}x per doubling, operations {counts:?}");
}

#[test]
fn many_lines_cost_what_one_line_costs_times_their_number() {
    let Some(data) = data() else { return };
    let line = "  const value = compute(items[i], { key: \"a\", n: 0x1F }); // note\n";
    for &language in LANGUAGES {
        let (worst, counts) = growth(&mut highlighter(&data, language), |n| line.repeat(n / 16));
        assert!(worst <= 2.3, "{language}: {worst:.2}x per doubling, operations {counts:?}");
    }
}

#[test]
fn deep_nesting_is_linear_and_fits_the_wasm_stack() {
    // Dropping a state stack thousands of levels deep recursed once per level and
    // overflowed wasm's 1 MB stack (Shiki highlights such code).
    let Some(data) = data() else { return };
    let (worst, counts) = growth(&mut highlighter(&data, "json"), |n| repeat("{\"a\":", n));
    assert!(worst <= 2.5, "{worst:.2}x per doubling, operations {counts:?}");
    let data = std::sync::Arc::new(data);
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            let mut json = highlighter(&data, "json");
            let code: Vec<u16> = "{\"a\":".repeat(30_000).encode_utf16().collect();
            let tokenized = json.tokenize(&code, None, 0).expect("tokenize");
            assert_eq!(tokenized.lines.len(), 1);
        })
        .expect("thread")
        .join()
        .expect("no stack overflow");
}

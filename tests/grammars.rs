//! Every regex of the bundled grammar files compiles (when the data build in
//! js/dist exists): a pattern the engine cannot compile would fail the first
//! tokenization that reaches it.

use rill_highlight::regex::{EmulationOptions, JsRegExp};
use serde_json::Value;
use std::path::Path;

#[test]
fn every_bundled_pattern_compiles() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("js/dist/grammars");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        eprintln!("skipped: no {} (run `npm run build` in js/)", directory.display());
        return;
    };
    let (mut compiled, mut failures) = (0, Vec::new());
    for entry in entries {
        let path = entry.expect("directory entry").path();
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("grammar file")).expect("grammar JSON");
        for (source, translation) in file["regexes"].as_object().expect("regexes") {
            // `0`: the source itself; a string: the pattern; both with flags `dgv`.
            let short = [Value::String(if translation.is_number() { source.clone() } else { translation.as_str().unwrap_or_default().to_string() }), Value::from("dgv"), Value::Null];
            let Some([pattern, flags, options]) = (if translation.is_array() { translation.as_array().map(Vec::as_slice) } else if translation.is_null() { None } else { Some(&short[..]) }) else { continue };
            let numbers = |value: &Value| value.as_array().map(|items| items.iter().filter_map(Value::as_u64).map(|n| n as u32).collect()).unwrap_or_default();
            let emulation = EmulationOptions {
                hidden_captures: numbers(&options["hiddenCaptures"]),
                transfers: options["transfers"]
                    .as_array()
                    .map(|items| items.iter().map(|item| (item[0].as_u64().unwrap_or(0) as u32, numbers(&item[1]))).collect())
                    .unwrap_or_default(),
                clip_search: options["strategy"].as_str() == Some("clip_search"),
            };
            let pattern = pattern.as_str().expect("pattern");
            let flags = flags.as_str().expect("flags");
            // Back-reference templates compile once their captures are known.
            let result = if source.chars().any(|c| ('\u{E000}'..='\u{E8FF}').contains(&c)) {
                JsRegExp::with_placeholders(pattern, flags, &emulation, &[])
            } else {
                JsRegExp::new(pattern, flags, &emulation)
            };
            match result {
                Ok(_) => compiled += 1,
                Err(error) => failures.push(format!("{}: {error}: {:.120}", path.display(), pattern)),
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} patterns do not compile:\n{}", failures.len(), compiled + failures.len(), failures.join("\n"));
    assert!(compiled > 20_000, "only {compiled} patterns");
}

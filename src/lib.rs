//! Shiki's syntax highlighting in Rust, token for token.
//!
//! TextMate grammars run the way `@shikijs/vscode-textmate` runs them on Shiki's
//! JavaScript regex engine, on the patterns `oniguruma-to-es` translates them to
//! (precompiled into the grammar files by `js/scripts/build-grammars.mjs`), with
//! an ECMAScript regex engine of its own. The tokens and their styles are
//! identical to Shiki's.
//!
//! ```no_run
//! # fn main() -> Result<(), rill_highlight::Error> {
//! let grammar = std::fs::read_to_string("js/dist/grammars/rust.json").expect("grammar");
//! let theme = std::fs::read_to_string("js/dist/themes/github-dark.json").expect("theme");
//! let mut highlighter = rill_highlight::Highlighter::from_json(&[&grammar], "rust", &[&theme])?;
//! let code: Vec<u16> = "fn main() {}".encode_utf16().collect();
//! let tokenized = highlighter.tokenize(&code, None, 0)?;
//! for token in &tokenized.lines[0] {
//!     let style = &highlighter.styles()[token.style as usize][0];
//!     println!("{} {:?}", token.offset, style.color);
//! }
//! # Ok(())
//! # }
//! ```

mod fxhash;
mod highlighter;
#[doc(hidden)]
pub mod ops;
pub mod regex;
mod textmate;

pub use highlighter::{Error, Highlighter, MAX_THEMES, Registry, State, Theme, ThemeStyle, Token, Tokenized};

#[cfg(feature = "wasm-exports")]
pub mod wasm;

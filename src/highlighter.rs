//! Shiki's `codeToTokensBase` / `codeToTokensWithThemes` for one to `MAX_THEMES`
//! themes in one pass: the grammar matches once and every theme styles the result.

use crate::regex::EmulationOptions;
use crate::textmate::grammar::{self, Grammar, Translation};
use crate::textmate::raw::RawGrammar;
use crate::textmate::theme::{NormalizedTheme, Theme as TextmateTheme, normalize_theme};
use crate::textmate::tokenizer::{self, Tokenizer};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

pub use crate::textmate::tokenizer::MAX_THEMES;

/// An error from loading a grammar or theme, or from tokenizing (a pattern that
/// does not compile, for one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    message: String,
}

impl Error {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    /// The error message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self { message }
    }
}

/// A grammar state between lines: pass the state a call returned to the next call
/// to continue the code (Shiki's `grammarState`). Only valid with the highlighter
/// that produced it.
#[derive(Debug, Clone)]
pub struct State(tokenizer::State);

impl State {
    /// The scope names of the state's rule stack, innermost first (Shiki's
    /// `GrammarState.getScopes`).
    #[must_use]
    pub fn scopes(&self) -> Vec<Rc<str>> {
        let mut scopes = Vec::new();
        let mut node = Some(&self.0);
        while let Some(state) = node {
            scopes.push(state.name_scopes.path.name.clone());
            node = state.parent.as_ref();
        }
        scopes
    }
}

/// The grammars a highlighter can use: a language's grammar and those it embeds
/// or that inject into it. Built from the data build's grammar files
/// (`{ grammar, regexes }` JSON, see `js/scripts/build-grammars.mjs`).
#[derive(Debug, Default, Clone)]
pub struct Registry {
    /// Shared with the highlighters made from it; copied on write.
    inner: Rc<grammar::Registry>,
}

impl Registry {
    /// Adds one grammar file.
    ///
    /// # Errors
    /// When the text is not a grammar file.
    pub fn add_grammar(&mut self, grammar_file: &str) -> Result<(), Error> {
        let (grammar, translations) = parse_grammar_file(grammar_file)?;
        Rc::make_mut(&mut self.inner).add_grammar(grammar, translations);
        Ok(())
    }

    /// The scope name of the grammar named `name` (a grammar's `name` or
    /// `scopeName`).
    #[must_use]
    pub fn scope_name(&self, name: &str) -> Option<Rc<str>> {
        self.inner.find(name).map(|grammar| grammar.scope_name.clone())
    }
}

/// A theme, normalized as Shiki's `normalizeTheme` does.
#[derive(Debug)]
pub struct Theme {
    normalized: NormalizedTheme,
    textmate: TextmateTheme,
}

impl Theme {
    /// Parses a theme JSON (a VS Code / TextMate theme as Shiki ships it).
    ///
    /// # Errors
    /// When the text is not a theme object.
    pub fn from_json(text: &str) -> Result<Self, Error> {
        let value: Value = serde_json::from_str(text).map_err(|error| Error::new(error.to_string()))?;
        let normalized = normalize_theme(&value)?;
        let textmate = TextmateTheme::new(&normalized.settings);
        Ok(Self { normalized, textmate })
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.normalized.name
    }

    /// `"light"` or `"dark"` (Shiki's default when the theme has none).
    #[must_use]
    pub fn theme_type(&self) -> &str {
        &self.normalized.theme_type
    }

    #[must_use]
    pub fn foreground(&self) -> &str {
        &self.normalized.fg
    }

    #[must_use]
    pub fn background(&self) -> &str {
        &self.normalized.bg
    }

    /// The theme's `colorReplacements`, including the placeholders normalization
    /// gives colors that are not hex. Keys match lower-cased colors.
    #[must_use]
    pub fn color_replacements(&self) -> &HashMap<String, String> {
        &self.normalized.color_replacements
    }

    /// A color of the theme's color map (`None` for an unused id).
    fn color(&self, color_id: u32) -> Option<&str> {
        self.textmate.color_map.get(color_id as usize)?.as_deref()
    }
}

/// How a token looks in one theme: its color-map color before color replacements
/// (`None` when the theme has none) and its font style (bit 1 italic, 2 bold, 4
/// underline, 8 strikethrough).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ThemeStyle {
    pub color: Option<Rc<str>>,
    pub font_style: u32,
}

/// A token: UTF-16 offset and length in the code and an index into
/// [`Highlighter::styles`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
    pub offset: u32,
    pub length: u32,
    pub style: u32,
}

/// The result of [`Highlighter::tokenize`].
#[derive(Debug)]
pub struct Tokenized {
    /// Tokens per line (lines split at `\r?\n`, as Shiki's `splitLines`).
    pub lines: Vec<Vec<Token>>,
    /// The state after the last line (`None`: the initial state).
    pub state: Option<State>,
}

/// The color id standing for Shiki's `color: ""` on lines over the maximum length.
const EMPTY_COLOR: u32 = u32::MAX;

/// A style key: (color id, font style) per theme.
type StyleKey = [(u32, u32); MAX_THEMES];

/// One theme's tokens of a line: (start, end, (color id, font style)).
type ThemeTokens = Vec<(usize, usize, (u32, u32))>;

/// Highlights one language with one or more themes.
pub struct Highlighter {
    grammar: Grammar,
    themes: Vec<Rc<Theme>>,
    style_ids: HashMap<StyleKey, u32>,
    styles: Vec<Vec<ThemeStyle>>,
}

impl Highlighter {
    /// A highlighter for the grammar named `language` (its `name` or `scopeName`)
    /// in `registry`, with one to [`MAX_THEMES`] themes.
    ///
    /// # Errors
    /// When the registry has no such grammar, the theme count is out of range, or
    /// the grammar's root rule does not compile.
    pub fn new(registry: &Registry, language: &str, themes: Vec<Rc<Theme>>) -> Result<Self, Error> {
        if themes.is_empty() || themes.len() > MAX_THEMES {
            return Err(Error::new(format!("between 1 and {MAX_THEMES} themes are supported, got {}", themes.len())));
        }
        let scope_name = registry.scope_name(language).ok_or_else(|| Error::new(format!("no grammar {language}")))?;
        let grammar = Grammar::new(registry.inner.clone(), &scope_name)?;
        Ok(Self { grammar, themes, style_ids: HashMap::new(), styles: Vec::new() })
    }

    /// A highlighter from grammar file texts (the language's grammars in Shiki's
    /// load order) and theme JSON texts.
    ///
    /// # Errors
    /// See [`Registry::add_grammar`], [`Theme::from_json`] and [`Highlighter::new`].
    pub fn from_json(grammar_files: &[&str], language: &str, themes: &[&str]) -> Result<Self, Error> {
        let mut registry = Registry::default();
        for file in grammar_files {
            registry.add_grammar(file)?;
        }
        let themes = themes.iter().map(|theme| Theme::from_json(theme).map(Rc::new)).collect::<Result<Vec<_>, _>>()?;
        Self::new(&registry, language, themes)
    }

    #[must_use]
    pub fn themes(&self) -> &[Rc<Theme>] {
        &self.themes
    }

    /// Each style id's look, per theme in the order the themes were given.
    #[must_use]
    pub fn styles(&self) -> &[Vec<ThemeStyle>] {
        &self.styles
    }

    /// Regex executions so far (for benchmarks).
    #[must_use]
    pub fn regex_executions(&self) -> u64 {
        self.grammar.execs
    }

    /// Tokenizes UTF-16 `code` after `state` (`None`: from the start). Lines of
    /// `max_line_length` or more UTF-16 units (when it is not 0) are not tokenized
    /// and keep the state, as Shiki's `tokenizeMaxLineLength`.
    ///
    /// # Errors
    /// When a pattern the code reaches does not compile.
    pub fn tokenize(&mut self, code: &[u16], state: Option<&State>, max_line_length: usize) -> Result<Tokenized, Error> {
        let mut state = state.map(|state| state.0.clone());
        let mut lines = Vec::new();
        let theme_count = self.themes.len();
        let themes = self.themes.clone();
        let textmate_themes: Vec<&TextmateTheme> = themes.iter().map(|theme| &theme.textmate).collect();
        let mut per_theme: Vec<ThemeTokens> = vec![Vec::new(); theme_count];
        for (start, end) in split_lines(code) {
            let line = &code[start..end];
            if line.is_empty() {
                lines.push(Vec::new());
                continue;
            }
            if max_line_length > 0 && line.len() >= max_line_length {
                let style = self.style_id(&[(EMPTY_COLOR, 0); MAX_THEMES]);
                lines.push(vec![Token { offset: start as u32, length: line.len() as u32, style }]);
                continue;
            }
            let mut tokenizer = Tokenizer { grammar: &mut self.grammar, themes: &textmate_themes };
            let (line_tokens, next_state, line_length) = tokenizer.tokenize_line(line, state.as_ref())?;
            // Per theme: tokens as (start, end, (color id, font style)), without
            // empty ones.
            for (theme, tokens) in per_theme.iter_mut().enumerate() {
                tokens.clear();
                let binary = line_tokens.binary_result(theme, &next_state, line_length);
                for (index, &(token_start, metadata)) in binary.iter().enumerate() {
                    let token_start = token_start as usize;
                    let token_end = binary.get(index + 1).map_or(line.len(), |&(next, _)| next as usize);
                    if token_start != token_end {
                        tokens.push((token_start, token_end, (tokenizer::foreground(metadata), tokenizer::font_style(metadata))));
                    }
                }
            }
            lines.push(self.align(&per_theme, start as u32));
            state = Some(next_state);
        }
        Ok(Tokenized { lines, state: state.map(State) })
    }

    /// `alignThemesTokenization`: splits every theme's tokens at the union of
    /// their boundaries.
    fn align(&mut self, per_theme: &[ThemeTokens], line_offset: u32) -> Vec<Token> {
        let mut out = Vec::with_capacity(per_theme.iter().map(Vec::len).max().unwrap_or(0));
        let mut indexes = [0usize; MAX_THEMES];
        let mut position = per_theme[0].first().map_or(0, |token| token.0);
        loop {
            let mut key: StyleKey = [(0, 0); MAX_THEMES];
            let mut end = usize::MAX;
            for (theme, tokens) in per_theme.iter().enumerate() {
                let Some(token) = tokens.get(indexes[theme]) else { return out };
                key[theme] = token.2;
                end = end.min(token.1);
            }
            let style = self.style_id(&key);
            out.push(Token { offset: line_offset + position as u32, length: (end - position) as u32, style });
            position = end;
            for (theme, tokens) in per_theme.iter().enumerate() {
                if tokens[indexes[theme]].1 == end {
                    indexes[theme] += 1;
                }
            }
        }
    }

    fn style_id(&mut self, key: &StyleKey) -> u32 {
        if let Some(&id) = self.style_ids.get(key) {
            return id;
        }
        let id = self.styles.len() as u32;
        let style = self
            .themes
            .iter()
            .zip(key)
            .map(|(theme, &(color_id, font_style))| ThemeStyle {
                color: if color_id == EMPTY_COLOR { Some(Rc::from("")) } else { theme.color(color_id).map(Rc::from) },
                font_style,
            })
            .collect();
        self.styles.push(style);
        self.style_ids.insert(*key, id);
        id
    }
}

/// Shiki `splitLines`: line ranges split at `\r?\n`.
#[must_use]
pub fn split_lines(code: &[u16]) -> Vec<(usize, usize)> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, &unit) in code.iter().enumerate() {
        if unit == 0x0A {
            let end = if index > start && code[index - 1] == 0x0D { index - 1 } else { index };
            lines.push((start, end));
            start = index + 1;
        }
    }
    lines.push((start, code.len()));
    lines
}

/// Oniguruma sources and their translations (`None`: skipped).
type Translations = Vec<(Rc<str>, Option<Translation>)>;

/// One grammar file of the data build (`{ grammar, regexes }`).
fn parse_grammar_file(text: &str) -> Result<(RawGrammar, Translations), Error> {
    let value: Value = serde_json::from_str(text).map_err(|error| Error::new(error.to_string()))?;
    let grammar = RawGrammar::from_json(&value["grammar"])?;
    let numbers = |value: &Value| -> Vec<u32> {
        value.as_array().map(|items| items.iter().filter_map(|item| item.as_u64().map(|n| n as u32)).collect()).unwrap_or_default()
    };
    let mut translations = Vec::new();
    if let Value::Object(regexes) = &value["regexes"] {
        for (source, translation) in regexes {
            let translation = match translation {
                Value::Array(parts) => {
                    let options = &parts[2];
                    Some(Translation {
                        pattern: Rc::from(parts[0].as_str().unwrap_or("")),
                        flags: Rc::from(parts[1].as_str().unwrap_or("")),
                        options: EmulationOptions {
                            hidden_captures: numbers(&options["hiddenCaptures"]),
                            transfers: options["transfers"]
                                .as_array()
                                .map(|items| items.iter().map(|transfer| (transfer[0].as_u64().unwrap_or(0) as u32, numbers(&transfer[1]))).collect())
                                .unwrap_or_default(),
                            clip_search: options["strategy"].as_str() == Some("clip_search"),
                        },
                    })
                }
                _ => None,
            };
            translations.push((Rc::from(source.as_str()), translation));
        }
    }
    Ok((grammar, translations))
}

#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = r##"{ "name": "t", "type": "light", "colors": { "editor.foreground": "#111111", "editor.background": "#fefefe" },
        "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#AA0000", "fontStyle": "bold" } }] }"##;
    const OTHER_THEME: &str = r##"{ "name": "u", "tokenColors": [{ "scope": "keyword.control", "settings": { "foreground": "var(--k)" } }] }"##;
    const GRAMMAR: &str = r#"{ "grammar": { "name": "mini", "scopeName": "source.mini", "patterns": [
        { "match": "\\bif\\b", "name": "keyword.control.mini" },
        { "begin": "/\\*", "end": "\\*/", "name": "comment.block.mini" } ] },
      "regexes": { "\\bif\\b": ["\\bif\\b", "dgv", null], "/\\*": ["\/\\*", "dgv", null], "\\*/": ["\\*\/", "dgv", null], "\uffff": ["\uffff", "dgv", null], "": ["", "dgv", null] } }"#;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn splits_lines_like_shiki() {
        assert_eq!(split_lines(&utf16("a\r\nb\n\nc")), vec![(0, 1), (3, 4), (5, 5), (6, 7)]);
        assert_eq!(split_lines(&utf16("")), vec![(0, 0)]);
        assert_eq!(split_lines(&utf16("\r")), vec![(0, 1)]);
    }

    #[test]
    fn styles_tokens_per_theme_and_aligns_them() {
        let mut highlighter = Highlighter::from_json(&[GRAMMAR], "mini", &[THEME, OTHER_THEME]).expect("highlighter");
        let tokenized = highlighter.tokenize(&utf16("x if y"), None, 0).expect("tokens");
        let line = &tokenized.lines[0];
        let spans: Vec<(u32, u32)> = line.iter().map(|token| (token.offset, token.length)).collect();
        assert_eq!(spans, vec![(0, 2), (2, 2), (4, 2)]);
        let keyword = &highlighter.styles()[line[1].style as usize];
        assert_eq!(keyword[0], ThemeStyle { color: Some(Rc::from("#AA0000")), font_style: 2 });
        // A color that is not hex comes back as its placeholder.
        let placeholder = keyword[1].color.clone().expect("color");
        assert_eq!(highlighter.themes()[1].color_replacements()[&*placeholder], "var(--k)");
    }

    #[test]
    fn continues_from_a_state() {
        let mut highlighter = Highlighter::from_json(&[GRAMMAR], "source.mini", &[THEME]).expect("highlighter");
        let first = highlighter.tokenize(&utf16("/* open"), None, 0).expect("tokens");
        let state = first.state.expect("state");
        assert_eq!(state.scopes().iter().map(|scope| &**scope).collect::<Vec<_>>(), ["comment.block.mini", "source.mini"]);
        let second = highlighter.tokenize(&utf16("if */ if"), Some(&state), 0).expect("tokens");
        let styles: Vec<u32> = second.lines[0].iter().map(|token| token.style).collect();
        assert_eq!(styles[0], first.lines[0][0].style, "still in the comment");
        assert_ne!(styles.last(), styles.first());
    }

    #[test]
    fn skips_long_lines_and_keeps_the_state() {
        let mut highlighter = Highlighter::from_json(&[GRAMMAR], "mini", &[THEME]).expect("highlighter");
        let tokenized = highlighter.tokenize(&utf16("if\nif if if"), None, 5).expect("tokens");
        assert_eq!(tokenized.lines[1].len(), 1);
        let style = &highlighter.styles()[tokenized.lines[1][0].style as usize][0];
        assert_eq!(style, &ThemeStyle { color: Some(Rc::from("")), font_style: 0 });
    }

    #[test]
    fn rejects_bad_input() {
        assert!(Highlighter::from_json(&[GRAMMAR], "nope", &[THEME]).is_err());
        assert!(Highlighter::from_json(&[GRAMMAR], "mini", &[]).is_err());
        assert!(Highlighter::from_json(&[GRAMMAR], "mini", &[THEME; MAX_THEMES + 1]).is_err());
        assert!(Theme::from_json("[]").is_err());
        assert!(Registry::default().add_grammar("{}").is_err());
    }
}

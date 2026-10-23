//! A small JSON reader and writer for the grammar and theme files, in place of
//! serde_json (which, with the order-preserving map the files need, was about
//! 40 KB of the wasm module). Objects keep their keys in document order, as
//! JavaScript does for the non-index keys the files use; a repeated key keeps its
//! first position and its last value, as `JSON.parse` does. Numbers are only
//! tested for zero and read as small integers here, so they are parsed as `f64`
//! without correct rounding of long fractions.

use std::fmt::Write;
use std::ops::Index;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map),
}

/// A JSON object: its entries in document order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Map {
    entries: Vec<(String, Value)>,
}

static NULL: Value = Value::Null;

impl Map {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    #[must_use]
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Sets `key` (in place when it is there, else at the end).
    pub fn insert(&mut self, key: String, value: Value) {
        match self.entries.iter_mut().find(|(name, _)| *name == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let index = self.entries.iter().position(|(name, _)| name == key)?;
        Some(self.entries.remove(index).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(key, _)| key)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

impl IntoIterator for Map {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl Index<&str> for Map {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

impl Index<&str> for Value {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

impl Index<usize> for Value {
    type Output = Value;
    fn index(&self, index: usize) -> &Value {
        self.as_array().and_then(|items| items.get(index)).unwrap_or(&NULL)
    }
}

impl Value {
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.get(key)
    }

    #[must_use]
    pub fn as_object(&self) -> Option<&Map> {
        if let Value::Object(map) = self { Some(map) } else { None }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        if let Value::Object(map) = self { Some(map) } else { None }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        if let Value::Array(items) = self { Some(items) } else { None }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Value::String(text) = self { Some(text) } else { None }
    }

    /// A non-negative integer (as `serde_json`'s `as_u64`, for numbers written
    /// without a fraction or exponent).
    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        match *self {
            Value::Number(n) if n >= 0.0 && n.fract() == 0.0 && n < 9_007_199_254_740_992.0 => Some(n as u64),
            _ => None,
        }
    }

    /// JavaScript truthiness.
    #[must_use]
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }
}

/// Parses a JSON text.
///
/// # Errors
/// When the text is not JSON, with the byte offset of the problem.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser { bytes: text.as_bytes(), text, pos: 0, depth: 0 };
    let value = parser.value()?;
    parser.space();
    if parser.pos != parser.bytes.len() {
        return Err(parser.error("trailing characters"));
    }
    Ok(value)
}

/// Nesting deeper than this is rejected (as serde_json's recursion limit does).
const MAX_DEPTH: u32 = 128;

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    pos: usize,
    depth: u32,
}

impl Parser<'_> {
    fn error(&self, what: &str) -> String {
        format!("invalid JSON at byte {}: {what}", self.pos)
    }

    fn space(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.bytes.get(self.pos) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        self.space();
        let found = self.bytes.get(self.pos) == Some(&byte);
        if found {
            self.pos += 1;
        }
        found
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, String> {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err(self.error("expected a value"))
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        self.space();
        match self.bytes.get(self.pos) {
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.error("expected a value")),
        }
    }

    fn nested(&mut self, read: fn(&mut Self) -> Result<Value, String>) -> Result<Value, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error("nested too deeply"));
        }
        self.pos += 1;
        let value = read(self);
        self.depth -= 1;
        value
    }

    fn array(&mut self) -> Result<Value, String> {
        let mut items = Vec::new();
        if self.eat(b']') {
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value()?);
            if self.eat(b']') {
                return Ok(Value::Array(items));
            }
            if !self.eat(b',') {
                return Err(self.error("expected `,` or `]`"));
            }
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        let mut entries: Vec<(String, Value)> = Vec::new();
        if !self.eat(b'}') {
            loop {
                self.space();
                if self.bytes.get(self.pos) != Some(&b'"') {
                    return Err(self.error("expected a key"));
                }
                let key = self.string()?;
                if !self.eat(b':') {
                    return Err(self.error("expected `:`"));
                }
                entries.push((key, self.value()?));
                if self.eat(b'}') {
                    break;
                }
                if !self.eat(b',') {
                    return Err(self.error("expected `,` or `}`"));
                }
            }
        }
        Ok(Value::Object(Map { entries: without_repeats(entries) }))
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        let negative = self.bytes[self.pos] == b'-';
        if negative {
            self.pos += 1;
        }
        let digits = |parser: &mut Self| {
            let from = parser.pos;
            while parser.bytes.get(parser.pos).is_some_and(u8::is_ascii_digit) {
                parser.pos += 1;
            }
            &parser.bytes[from..parser.pos]
        };
        let integer = digits(self);
        if integer.is_empty() {
            return Err(self.error("expected digits"));
        }
        let mut value = integer.iter().fold(0.0, |n, &d| n * 10.0 + f64::from(d - b'0'));
        if self.bytes.get(self.pos) == Some(&b'.') {
            self.pos += 1;
            let fraction = digits(self);
            if fraction.is_empty() {
                return Err(self.error("expected digits"));
            }
            let mut scale = 0.1;
            for &d in fraction {
                value += f64::from(d - b'0') * scale;
                scale /= 10.0;
            }
        }
        if let Some(b'e' | b'E') = self.bytes.get(self.pos) {
            self.pos += 1;
            let negative_exponent = self.bytes.get(self.pos) == Some(&b'-');
            if let Some(b'+' | b'-') = self.bytes.get(self.pos) {
                self.pos += 1;
            }
            let exponent = digits(self);
            if exponent.is_empty() {
                return Err(self.error("expected digits"));
            }
            let exponent = exponent.iter().fold(0i32, |n, &d| n.saturating_mul(10).saturating_add(i32::from(d - b'0')));
            value *= 10f64.powi(if negative_exponent { -exponent } else { exponent });
        }
        debug_assert!(self.pos > start);
        Ok(Value::Number(if negative { -value } else { value }))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.bytes.get(self.pos..self.pos + 4).ok_or_else(|| self.error("short \\u escape"))?;
        let mut value = 0;
        for &digit in digits {
            value = value * 16 + (digit as char).to_digit(16).ok_or_else(|| self.error("bad \\u escape"))?;
        }
        self.pos += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let from = self.pos;
            while let Some(&byte) = self.bytes.get(self.pos) {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            // The run ends at an ASCII byte, so it is whole UTF-8.
            out.push_str(&self.text[from..self.pos]);
            match self.bytes.get(self.pos) {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = *self.bytes.get(self.pos).ok_or_else(|| self.error("unterminated string"))?;
                    self.pos += 1;
                    let c = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let unit = self.hex4()?;
                            let code_point = if (0xD800..0xDC00).contains(&unit) {
                                if !self.bytes[self.pos..].starts_with(b"\\u") {
                                    return Err(self.error("lone surrogate"));
                                }
                                self.pos += 2;
                                let low = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(self.error("lone surrogate"));
                                }
                                0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                unit
                            };
                            char::from_u32(code_point).ok_or_else(|| self.error("lone surrogate"))?
                        }
                        _ => return Err(self.error("bad escape")),
                    };
                    out.push(c);
                }
                _ => return Err(self.error("unterminated string")),
            }
        }
    }
}

/// An object's entries with a repeated key kept at its first position, holding its
/// last value (`JSON.parse`). Repeats are rare: they are found by sorting the keys.
fn without_repeats(mut entries: Vec<(String, Value)>) -> Vec<(String, Value)> {
    if entries.len() < 2 {
        return entries;
    }
    let mut order: Vec<usize> = (0..entries.len()).collect();
    crate::sort::sort_by(&mut order, |&a, &b| entries[a].0.cmp(&entries[b].0));
    if order.windows(2).all(|pair| entries[pair[0]].0 != entries[pair[1]].0) {
        return entries;
    }
    let runs: Vec<Vec<usize>> = order.chunk_by(|&a, &b| entries[a].0 == entries[b].0).filter(|run| run.len() > 1).map(<[usize]>::to_vec).collect();
    let mut drop = vec![false; entries.len()];
    for run in runs {
        // `order` is stable: the run is in document order.
        let value = std::mem::replace(&mut entries[run[run.len() - 1]].1, Value::Null);
        entries[run[0]].1 = value;
        for &index in &run[1..] {
            drop[index] = true;
        }
    }
    entries.into_iter().zip(drop).filter(|(_, dropped)| !dropped).map(|(entry, _)| entry).collect()
}

/// Appends `text` as a JSON string.
pub fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::{Value, parse, write_string};

    #[test]
    fn reads_json() {
        let value = parse(r#" { "a": [1, -2.5, 3e2, true, false, null], "b": "x\"\\\/\b\f\n\r\t\u00e9\ud83d\ude00", "c": {} } "#).expect("json");
        assert_eq!(value["a"].as_array().map(Vec::len), Some(6));
        assert_eq!(value["a"].as_array().expect("array")[0].as_u64(), Some(1));
        assert_eq!(value["a"].as_array().expect("array")[2], Value::Number(300.0));
        assert_eq!(value["b"].as_str(), Some("x\"\\/\u{8}\u{c}\n\r\té😀"));
        assert!(value["c"].as_object().is_some_and(|map| map.len() == 0));
        assert_eq!(value["missing"], Value::Null);
        for bad in ["", "{", "[1,]", "{\"a\" 1}", "\"\\ud800\"", "01x", "nul", "[1] 2", "\"a"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keeps_document_order_and_the_last_repeat() {
        let value = parse(r#"{"z": 1, "a": 2, "z": 3, "m": 4}"#).expect("json");
        let entries: Vec<(&str, u64)> = value.as_object().expect("object").iter().map(|(k, v)| (k.as_str(), v.as_u64().expect("int"))).collect();
        assert_eq!(entries, [("z", 3), ("a", 2), ("m", 4)]);
    }

    #[test]
    fn writes_strings() {
        let mut out = String::new();
        write_string(&mut out, "a\"b\\c\n\u{1}é");
        assert_eq!(out, r#""a\"b\\c\n\u0001é""#);
    }
}

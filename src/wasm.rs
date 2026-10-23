//! C-ABI exports for the JavaScript package (`js/src/wasm.js`).
//!
//! Registries, themes, highlighters and states are referred to by handles: small
//! integers, 0 for none or failure. Strings go in as UTF-8 (JSON) or UTF-16 (code)
//! in buffers from `rhl_alloc`. Text results and error messages come back in one
//! buffer (`rhl_text`, `rhl_text_len`) that the caller reads before the next call.

use crate::highlighter::{Highlighter, Registry, State, Theme};
use crate::json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write;
use std::rc::Rc;

#[derive(Default)]
struct Exports {
    registries: HashMap<u32, Registry>,
    themes: HashMap<u32, Rc<Theme>>,
    highlighters: HashMap<u32, Highlighter>,
    states: HashMap<u32, State>,
    next_handle: u32,
    result: Vec<u32>,
    text: Vec<u8>,
}

thread_local! {
    static EXPORTS: RefCell<Exports> = RefCell::new(Exports::default());
}

impl Exports {
    fn handle(&mut self) -> u32 {
        self.next_handle += 1;
        self.next_handle
    }

    fn set_text(&mut self, text: &str) {
        self.text.clear();
        self.text.extend_from_slice(text.as_bytes());
    }

    /// Records `error` as the text and returns the failure handle.
    fn fail(&mut self, error: &str) -> u32 {
        self.set_text(error);
        0
    }
}

/// Allocates `length` bytes for the caller to fill.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_alloc(length: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(length.max(1));
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Frees a buffer from `rhl_alloc`.
///
/// # Safety
/// `pointer` and `length` must come from one `rhl_alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rhl_free(pointer: *mut u8, length: usize) {
    drop(unsafe { Vec::from_raw_parts(pointer, 0, length.max(1)) });
}

unsafe fn read_utf8(pointer: *const u8, length: usize) -> String {
    String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(pointer, length) }).into_owned()
}

/// Creates an empty grammar registry.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_registry_new() -> u32 {
    EXPORTS.with_borrow_mut(|exports| {
        let handle = exports.handle();
        exports.registries.insert(handle, Registry::default());
        handle
    })
}

/// Adds a grammar file (UTF-8 JSON) to a registry. Returns 1, or 0 on error.
///
/// # Safety
/// `pointer..pointer + length` must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rhl_registry_add_grammar(registry: u32, pointer: *const u8, length: usize) -> u32 {
    let text = unsafe { read_utf8(pointer, length) };
    EXPORTS.with_borrow_mut(|exports| {
        let Some(target) = exports.registries.get_mut(&registry) else { return exports.fail("unknown registry") };
        match target.add_grammar(&text) {
            Ok(()) => 1,
            Err(error) => exports.fail(error.message()),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rhl_registry_free(registry: u32) {
    EXPORTS.with_borrow_mut(|exports| exports.registries.remove(&registry));
}

/// Loads a theme (UTF-8 JSON). Returns its handle and sets the text to its
/// normalized `[name, type, fg, bg, colorReplacements]`, or returns 0.
///
/// # Safety
/// `pointer..pointer + length` must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rhl_theme_new(pointer: *const u8, length: usize) -> u32 {
    let text = unsafe { read_utf8(pointer, length) };
    EXPORTS.with_borrow_mut(|exports| match Theme::from_json(&text) {
        Ok(theme) => {
            let mut info = String::from("[");
            for field in [theme.name(), theme.theme_type(), theme.foreground(), theme.background()] {
                json::write_string(&mut info, field);
                info.push(',');
            }
            info.push('{');
            for (index, (from, to)) in theme.color_replacements().iter().enumerate() {
                if index > 0 {
                    info.push(',');
                }
                json::write_string(&mut info, from);
                info.push(':');
                json::write_string(&mut info, to);
            }
            info.push_str("}]");
            exports.set_text(&info);
            let handle = exports.handle();
            exports.themes.insert(handle, Rc::new(theme));
            handle
        }
        Err(error) => exports.fail(error.message()),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rhl_theme_free(theme: u32) {
    EXPORTS.with_borrow_mut(|exports| exports.themes.remove(&theme));
}

/// Creates a highlighter for the grammar named `name` in `registry` with
/// `theme_count` theme handles at `themes`. Returns 0 on error.
///
/// # Safety
/// `name..name + name_length` and `themes..themes + theme_count` must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rhl_highlighter_new(registry: u32, name: *const u8, name_length: usize, themes: *const u32, theme_count: usize) -> u32 {
    let name = unsafe { read_utf8(name, name_length) };
    let theme_handles = unsafe { std::slice::from_raw_parts(themes, theme_count) };
    EXPORTS.with_borrow_mut(|exports| {
        let Some(themes) = theme_handles.iter().map(|handle| exports.themes.get(handle).cloned()).collect::<Option<Vec<_>>>() else {
            return exports.fail("unknown theme");
        };
        let Some(source) = exports.registries.get(&registry) else { return exports.fail("unknown registry") };
        match Highlighter::new(source, &name, themes) {
            Ok(highlighter) => {
                let handle = exports.handle();
                exports.highlighters.insert(handle, highlighter);
                handle
            }
            Err(error) => exports.fail(error.message()),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rhl_highlighter_free(highlighter: u32) {
    EXPORTS.with_borrow_mut(|exports| exports.highlighters.remove(&highlighter));
}

/// Tokenizes UTF-16 `code` after grammar state `state` (0: initial), skipping
/// lines of `max_line_length` units or more when it is not 0. Returns a pointer
/// to u32s: [state handle (0: initial), the number of u32s that follow, the
/// highlighter's style count, line count, then per line the token count and
/// (offset, length, style) per token], or null on error.
///
/// # Safety
/// `code..code + length` must be readable UTF-16.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rhl_tokenize(highlighter: u32, code: *const u16, length: usize, state: u32, max_line_length: usize) -> *const u32 {
    let code = unsafe { std::slice::from_raw_parts(code, length) };
    EXPORTS.with_borrow_mut(|exports| {
        let previous = if state == 0 { None } else { exports.states.get(&state).cloned() };
        let Some(target) = exports.highlighters.get_mut(&highlighter) else {
            exports.fail("unknown highlighter");
            return std::ptr::null();
        };
        let tokenized = target.tokenize(code, previous.as_ref(), max_line_length);
        let style_count = target.styles().len() as u32;
        match tokenized {
            Ok(tokenized) => {
                let state_handle = match tokenized.state {
                    Some(state) => {
                        let handle = exports.handle();
                        exports.states.insert(handle, state);
                        handle
                    }
                    None => 0,
                };
                let result = &mut exports.result;
                result.clear();
                result.extend_from_slice(&[state_handle, 0, style_count, tokenized.lines.len() as u32]);
                for line in &tokenized.lines {
                    result.push(line.len() as u32);
                    for token in line {
                        result.extend_from_slice(&[token.offset, token.length, token.style]);
                    }
                }
                result[1] = (result.len() - 2) as u32;
                result.as_ptr()
            }
            Err(error) => {
                exports.fail(error.message());
                std::ptr::null()
            }
        }
    })
}

/// Releases a grammar state handle.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_state_free(state: u32) {
    EXPORTS.with_borrow_mut(|exports| exports.states.remove(&state));
}

/// Sets the text to a state's scope names (innermost first) as a JSON array;
/// returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_state_scopes(state: u32) -> usize {
    EXPORTS.with_borrow_mut(|exports| {
        let scopes = exports.states.get(&state).map(State::scopes).unwrap_or_default();
        let mut text = String::from("[");
        for (index, scope) in scopes.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            json::write_string(&mut text, scope);
        }
        text.push(']');
        exports.set_text(&text);
        exports.text.len()
    })
}

/// Sets the text to the styles `from..` of a highlighter, as a JSON array with,
/// per style, a `[color or null, font style]` pair per theme; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_styles(highlighter: u32, from: u32) -> usize {
    EXPORTS.with_borrow_mut(|exports| {
        let Some(target) = exports.highlighters.get(&highlighter) else { return 0 };
        let mut text = String::from("[");
        for (index, style) in target.styles()[from as usize..].iter().enumerate() {
            text.push_str(if index > 0 { ",[" } else { "[" });
            for (theme, look) in style.iter().enumerate() {
                text.push_str(if theme > 0 { ",[" } else { "[" });
                match look.color.as_deref() {
                    Some(color) => json::write_string(&mut text, color),
                    None => text.push_str("null"),
                }
                let _ = write!(text, ",{}]", look.font_style);
            }
            text.push(']');
        }
        text.push(']');
        exports.set_text(&text);
        exports.text.len()
    })
}

/// Pointer to the text buffer.
#[unsafe(no_mangle)]
pub extern "C" fn rhl_text() -> *const u8 {
    EXPORTS.with_borrow(|exports| exports.text.as_ptr())
}

/// Length of the text buffer (the last error message after a failure).
#[unsafe(no_mangle)]
pub extern "C" fn rhl_text_len() -> usize {
    EXPORTS.with_borrow(|exports| exports.text.len())
}

//! The backtracking matcher over UTF-16 input (code points, as in `u`/`v` mode).

use super::compile::{Inst, Program};
use super::parse::Assertion;
use crate::fxhash::FxHashMap;

#[derive(Debug, Clone, Copy)]
enum Frame {
    /// Resume at `pc` at `pos`.
    Alt { pc: u32, pos: u32 },
    /// Try the alternatives of a table from `next` on, at `pos`.
    AltTable { table: u32, next: u32, pos: u32 },
    /// Restore a capture slot.
    Capture { slot: u32, old: i32 },
    /// Restore a loop register.
    Loop { reg: u32, count: u32, start: u32 },
    /// A greedy `SetRepeat` (the instruction before `pc`) that can give back characters
    /// until it is at `min_pos`.
    Star { pc: u32, min_pos: u32, pos: u32 },
    /// A lazy `SetRepeat` (the instruction before `pc`) that can take up to
    /// `remaining` more characters.
    LazyStar { pc: u32, pos: u32, remaining: u32 },
}

/// Where a required literal next occurs in an input, searched from `from`
/// (`None`: nowhere at or after `from`).
#[derive(Debug, Clone, Copy)]
struct LiteralScan {
    from: usize,
    next: Option<usize>,
}

/// Literal scans kept before the cache starts over.
const MAX_LITERAL_SCANS: usize = 4096;

/// Inputs shorter than this (from the search start) are scanned every time:
/// that is cheaper than looking the scan up.
const MIN_REMEMBERED_SCAN: usize = 256;

/// Reusable matcher state.
#[derive(Default)]
pub struct Matcher {
    stack: Vec<Frame>,
    loops: Vec<(u32, u32)>,
    /// The caller's identifier for the input the next searches run on (see
    /// `set_input_id`).
    input_id: Option<u64>,
    /// Required-literal scans by (literal address, input id, input length).
    literal_scans: FxHashMap<(usize, u64, usize), LiteralScan>,
}

impl Matcher {
    /// Declares that the following searches run on the input identified by `id`
    /// (the same content for as long as the id is in use), so the matcher can
    /// remember where required literals occur instead of scanning for them on
    /// every search. Without an id (the default) nothing is remembered.
    pub fn set_input_id(&mut self, id: Option<u64>) {
        self.input_id = id;
    }

    /// Whether `literal` occurs in `input` at or after `pos`.
    fn has_literal(&mut self, literal: &[(u16, u16)], input: &[u16], pos: usize) -> bool {
        let Some(id) = self.input_id.filter(|_| input.len() - pos >= MIN_REMEMBERED_SCAN) else {
            crate::ops::add(input.len() - pos);
            return find_literal(&input[pos..], literal).is_some();
        };
        let key = (literal.as_ptr() as usize, id, input.len());
        if let Some(scan) = self.literal_scans.get(&key) {
            match scan.next {
                None if pos >= scan.from => return false,
                Some(next) if next >= pos => return true,
                _ => {}
            }
        }
        let next = find_literal(&input[pos..], literal).map(|index| index + pos);
        crate::ops::add(next.unwrap_or(input.len()) - pos);
        if self.literal_scans.len() >= MAX_LITERAL_SCANS {
            self.literal_scans.clear();
        }
        self.literal_scans.insert(key, LiteralScan { from: pos, next });
        next.is_some()
    }
}

#[inline]
fn is_lead(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

#[inline]
fn is_trail(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

/// The code point at `pos` and the position after it.
#[inline]
fn next_char(input: &[u16], pos: usize) -> Option<(u32, usize)> {
    let unit = *input.get(pos)?;
    if is_lead(unit)
        && let Some(&low) = input.get(pos + 1)
        && is_trail(low)
    {
        let code_point = 0x10000 + ((u32::from(unit) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
        return Some((code_point, pos + 2));
    }
    Some((u32::from(unit), pos + 1))
}

/// The code point ending at `pos` and the position before it.
#[inline]
fn prev_char(input: &[u16], pos: usize) -> Option<(u32, usize)> {
    if pos == 0 {
        return None;
    }
    let unit = input[pos - 1];
    if is_trail(unit) && pos >= 2 && is_lead(input[pos - 2]) {
        let code_point = 0x10000 + ((u32::from(input[pos - 2]) - 0xD800) << 10) + (u32::from(unit) - 0xDC00);
        return Some((code_point, pos - 2));
    }
    Some((u32::from(unit), pos - 1))
}

#[inline]
fn step(input: &[u16], pos: usize, back: bool) -> Option<(u32, usize)> {
    if back { prev_char(input, pos) } else { next_char(input, pos) }
}

/// The first index where `literal` (code units, each with its case variant)
/// occurs in `haystack`.
fn find_literal(haystack: &[u16], literal: &[(u16, u16)]) -> Option<usize> {
    let Some(&(first, first_variant)) = literal.first() else { return Some(0) };
    if haystack.len() < literal.len() {
        return None;
    }
    (0..=haystack.len() - literal.len()).find(|&index| {
        let unit = haystack[index];
        (unit == first || unit == first_variant)
            && literal[1..].iter().zip(&haystack[index + 1..]).all(|(&(unit, variant), &actual)| actual == unit || actual == variant)
    })
}

/// Whether the code unit at `pos` can start what follows a repeat.
#[inline]
fn may_follow(follow: &super::compile::FirstUnits, input: &[u16], pos: usize) -> bool {
    pos < input.len() && follow.may_start(input[pos])
}

#[inline]
fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029)
}

#[inline]
fn is_word_unit(unit: u16, extended: bool) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5A | 0x5F | 0x61..=0x7A) || (extended && (unit == 0x017F || unit == 0x212A))
}

impl Matcher {
    /// Searches `input` for a match starting in `start..=limit` (only at `start`
    /// when `sticky`). On a match, fills `captures` (two slots per group, -1 for
    /// undefined) and returns true; false means no match starts in that range.
    pub fn exec(&mut self, program: &Program, input: &[u16], start: usize, limit: usize, sticky: bool, captures: &mut Vec<i32>) -> bool {
        let slots = (program.group_count as usize + 1) * 2;
        captures.clear();
        captures.resize(slots, -1);
        self.loops.clear();
        self.loops.resize(program.loop_count as usize, (0, 0));
        let len = input.len();
        let mut pos = start;
        if pos > len {
            return false;
        }
        // A start inside a surrogate pair moves back to the pair, as V8 does.
        if pos > 0 && pos < len && is_trail(input[pos]) && is_lead(input[pos - 1]) {
            pos -= 1;
        }
        if let Some(literal) = &program.required_literal
            && !self.has_literal(literal, input, pos)
        {
            return false;
        }
        if sticky {
            return self.attempt(program, input, pos, captures);
        }
        if program.anchored_start {
            return pos == 0 && self.attempt(program, input, 0, captures);
        }
        match &program.first_units {
            Some(first) => {
                let end = len.min(limit.saturating_add(1));
                while pos < end {
                    crate::ops::add(1);
                    let unit = input[pos];
                    if first.may_start(unit) && !(is_trail(unit) && pos > start && is_lead(input[pos - 1])) && self.attempt(program, input, pos, captures) {
                        return true;
                    }
                    pos += 1;
                }
                false
            }
            None => loop {
                crate::ops::add(1);
                if pos > limit {
                    return false;
                }
                if self.attempt(program, input, pos, captures) {
                    return true;
                }
                match next_char(input, pos) {
                    Some((_, next)) => pos = next,
                    None => return false,
                }
            },
        }
    }

    fn attempt(&mut self, program: &Program, input: &[u16], pos: usize, captures: &mut Vec<i32>) -> bool {
        self.stack.clear();
        match self.run(program, input, 0, pos, 0, captures) {
            Some(end) => {
                captures[0] = pos as i32;
                captures[1] = end as i32;
                true
            }
            None => false,
        }
    }

    /// Runs from `pc` at `pos` until `Match`/`LookEnd` (the end position) or until
    /// every alternative above `base` failed.
    fn run(&mut self, program: &Program, input: &[u16], mut pc: usize, mut pos: usize, base: usize, captures: &mut Vec<i32>) -> Option<usize> {
        let insts = &program.insts;
        loop {
            crate::ops::add(1);
            let ok = match &insts[pc] {
                Inst::Unit { unit, back } => {
                    if *back {
                        if pos > 0 && input[pos - 1] == *unit {
                            pos -= 1;
                            pc += 1;
                            true
                        } else {
                            false
                        }
                    } else if pos < input.len() && input[pos] == *unit {
                        pos += 1;
                        pc += 1;
                        true
                    } else {
                        false
                    }
                }
                Inst::Unit2 { a, b, back } => {
                    if *back {
                        if pos > 0 && (input[pos - 1] == *a || input[pos - 1] == *b) {
                            pos -= 1;
                            pc += 1;
                            true
                        } else {
                            false
                        }
                    } else if pos < input.len() && (input[pos] == *a || input[pos] == *b) {
                        pos += 1;
                        pc += 1;
                        true
                    } else {
                        false
                    }
                }
                Inst::Set { set, back } => match step(input, pos, *back) {
                    Some((c, next)) if program.sets[*set as usize].contains(c) => {
                        pos = next;
                        pc += 1;
                        true
                    }
                    _ => false,
                },
                Inst::SetRepeat { set, min, max, greedy, back, possessive, follow } => {
                    let set = &program.sets[*set as usize];
                    let follow = program.follows.get(*follow as usize);
                    let mut count = 0u32;
                    let mut position = pos;
                    while count < *min {
                        match step(input, position, *back) {
                            Some((c, next)) if set.contains(c) => {
                                position = next;
                                count += 1;
                            }
                            _ => break,
                        }
                    }
                    if count < *min {
                        false
                    } else if *greedy {
                        let min_pos = position;
                        while count < *max {
                            match step(input, position, *back) {
                                Some((c, next)) if set.contains(c) => {
                                    position = next;
                                    count += 1;
                                }
                                _ => break,
                            }
                        }
                        if let Some(follow) = follow {
                            while position != min_pos && !may_follow(follow, input, position) {
                                position = prev_char(input, position).expect("not at the start").1;
                            }
                        }
                        crate::ops::add(count as usize);
                        if position == min_pos && follow.is_some_and(|follow| !may_follow(follow, input, position)) {
                            false
                        } else {
                            if position != min_pos && !*possessive {
                                self.stack.push(Frame::Star { pc: pc as u32 + 1, min_pos: min_pos as u32, pos: position as u32 });
                            }
                            pos = position;
                            pc += 1;
                            true
                        }
                    } else {
                        let mut remaining = if *max == u32::MAX { u32::MAX } else { max - min };
                        let mut ok = true;
                        if let Some(follow) = follow {
                            while !may_follow(follow, input, position) {
                                match step(input, position, *back) {
                                    Some((c, next)) if remaining > 0 && set.contains(c) => {
                                        position = next;
                                        if remaining != u32::MAX {
                                            remaining -= 1;
                                        }
                                    }
                                    _ => {
                                        ok = false;
                                        break;
                                    }
                                }
                            }
                        }
                        crate::ops::add(position.abs_diff(pos));
                        if ok {
                            if remaining > 0 {
                                self.stack.push(Frame::LazyStar { pc: pc as u32 + 1, pos: position as u32, remaining });
                            }
                            pos = position;
                            pc += 1;
                        }
                        ok
                    }
                }
                Inst::AltTable { table } => match self.next_alternative(program, input, *table, 0, pos) {
                    Some(target) => {
                        pc = target;
                        true
                    }
                    None => false,
                },
                Inst::Split { alt } => {
                    self.stack.push(Frame::Alt { pc: *alt, pos: pos as u32 });
                    pc += 1;
                    true
                }
                Inst::Jump { to } => {
                    pc = *to as usize;
                    true
                }
                Inst::Save { slot } => {
                    let slot = *slot as usize;
                    self.stack.push(Frame::Capture { slot: slot as u32, old: captures[slot] });
                    captures[slot] = pos as i32;
                    pc += 1;
                    true
                }
                Inst::ClearCaptures { from, to } => {
                    self.clear_captures(*from, *to, captures);
                    pc += 1;
                    true
                }
                Inst::LoopInit { reg } => {
                    let (count, start) = self.loops[*reg as usize];
                    self.stack.push(Frame::Loop { reg: *reg, count, start });
                    self.loops[*reg as usize] = (0, u32::MAX);
                    pc += 1;
                    true
                }
                Inst::LoopTest { reg, min, max, greedy, exit } => {
                    let count = self.loops[*reg as usize].0;
                    if count >= *max {
                        pc = *exit as usize;
                    } else if count < *min {
                        pc += 1;
                    } else if *greedy {
                        self.stack.push(Frame::Alt { pc: *exit, pos: pos as u32 });
                        pc += 1;
                    } else {
                        self.stack.push(Frame::Alt { pc: pc as u32 + 1, pos: pos as u32 });
                        pc = *exit as usize;
                    }
                    true
                }
                Inst::LoopEnter { reg, clear_from, clear_to } => {
                    let (count, start) = self.loops[*reg as usize];
                    self.stack.push(Frame::Loop { reg: *reg, count, start });
                    self.loops[*reg as usize] = (count + 1, pos as u32);
                    self.clear_captures(*clear_from, *clear_to, captures);
                    pc += 1;
                    true
                }
                Inst::LoopEnd { reg, min, test } => {
                    let (count, start) = self.loops[*reg as usize];
                    if count > *min && pos as u32 == start {
                        false
                    } else {
                        pc = *test as usize;
                        true
                    }
                }
                Inst::Assert(assertion) => {
                    let ok = match *assertion {
                        Assertion::InputStart => pos == 0,
                        Assertion::InputEnd => pos == input.len(),
                        Assertion::LineStart => pos == 0 || is_line_terminator(input[pos - 1]),
                        Assertion::LineEnd => pos == input.len() || is_line_terminator(input[pos]),
                        Assertion::WordBoundary { extended } | Assertion::NotWordBoundary { extended } => {
                            let before = pos > 0 && is_word_unit(input[pos - 1], extended);
                            let after = pos < input.len() && is_word_unit(input[pos], extended);
                            (before != after) == matches!(assertion, Assertion::WordBoundary { .. })
                        }
                    };
                    if ok {
                        pc += 1;
                    }
                    ok
                }
                Inst::Look { body, next, negate } => {
                    let look_base = self.stack.len();
                    let matched = self.run(program, input, *body as usize, pos, look_base, captures).is_some();
                    if matched {
                        if *negate {
                            self.unwind(look_base, captures);
                            false
                        } else {
                            self.keep_undo_records(look_base);
                            pc = *next as usize;
                            true
                        }
                    } else if *negate {
                        pc = *next as usize;
                        true
                    } else {
                        false
                    }
                }
                Inst::Atomic { body, next } => {
                    let atomic_base = self.stack.len();
                    match self.run(program, input, *body as usize, pos, atomic_base, captures) {
                        Some(end) => {
                            self.keep_undo_records(atomic_base);
                            pos = end;
                            pc = *next as usize;
                            true
                        }
                        None => false,
                    }
                }
                Inst::LookEnd | Inst::Match => return Some(pos),
                Inst::Backref { groups, ignore_case, back } => match self.match_backref(program, input, *groups, *ignore_case, *back, pos, captures) {
                    Some(next) => {
                        pos = next;
                        pc += 1;
                        true
                    }
                    None => false,
                },
            };
            if ok {
                continue;
            }
            // Backtrack.
            loop {
                crate::ops::add(1);
                if self.stack.len() == base {
                    return None;
                }
                match self.stack.pop().expect("a frame above the base") {
                    Frame::Alt { pc: alt_pc, pos: alt_pos } => {
                        pc = alt_pc as usize;
                        pos = alt_pos as usize;
                        break;
                    }
                    Frame::Capture { slot, old } => captures[slot as usize] = old,
                    Frame::Loop { reg, count, start } => self.loops[reg as usize] = (count, start),
                    Frame::AltTable { table, next, pos: at } => {
                        if let Some(target) = self.next_alternative(program, input, table, next as usize, at as usize) {
                            pc = target;
                            pos = at as usize;
                            break;
                        }
                    }
                    Frame::Star { pc: resume, min_pos, pos: at } => {
                        let Inst::SetRepeat { back, follow, .. } = insts[resume as usize - 1] else { unreachable!() };
                        let follow = program.follows.get(follow as usize);
                        // Give back one character, then more while the rest cannot match.
                        let mut previous = step(input, at as usize, !back).expect("inside the input").1;
                        if let Some(follow) = follow {
                            while previous as u32 != min_pos && !may_follow(follow, input, previous) {
                                previous = prev_char(input, previous).expect("not at the start").1;
                            }
                            if previous as u32 == min_pos && !may_follow(follow, input, previous) {
                                continue;
                            }
                        }
                        crate::ops::add(previous.abs_diff(at as usize));
                        if previous as u32 != min_pos {
                            self.stack.push(Frame::Star { pc: resume, min_pos, pos: previous as u32 });
                        }
                        pc = resume as usize;
                        pos = previous;
                        break;
                    }
                    Frame::LazyStar { pc: resume, pos: at, remaining } => {
                        let Inst::SetRepeat { set, back, follow, .. } = insts[resume as usize - 1] else { unreachable!() };
                        let set = &program.sets[set as usize];
                        let follow = program.follows.get(follow as usize);
                        // Take one more character, then more until the rest may match.
                        let mut position = at as usize;
                        let mut remaining = remaining;
                        let mut ok = false;
                        loop {
                            match step(input, position, back) {
                                Some((c, next)) if remaining > 0 && set.contains(c) => {
                                    position = next;
                                    if remaining != u32::MAX {
                                        remaining -= 1;
                                    }
                                }
                                _ => break,
                            }
                            if follow.is_none_or(|follow| may_follow(follow, input, position)) {
                                ok = true;
                                break;
                            }
                        }
                        crate::ops::add(position.abs_diff(at as usize));
                        if ok {
                            if remaining > 0 {
                                self.stack.push(Frame::LazyStar { pc: resume, pos: position as u32, remaining });
                            }
                            pc = resume as usize;
                            pos = position;
                            break;
                        }
                    }
                }
            }
        }
    }

    /// The first viable alternative of `table` from index `from` on; pushes a frame
    /// for the ones after it.
    fn next_alternative(&mut self, program: &Program, input: &[u16], table: u32, from: usize, pos: usize) -> Option<usize> {
        let table_data = &program.alt_tables[table as usize];
        let (index, more) = table_data.next(input.get(pos).copied(), from)?;
        if more {
            self.stack.push(Frame::AltTable { table, next: index as u32 + 1, pos: pos as u32 });
        }
        Some(table_data.pcs[index] as usize)
    }

    fn keep_undo_records(&mut self, base: usize) {
        let mut keep = base;
        for i in base..self.stack.len() {
            let frame = self.stack[i];
            if matches!(frame, Frame::Capture { .. } | Frame::Loop { .. }) {
                self.stack[keep] = frame;
                keep += 1;
            }
        }
        self.stack.truncate(keep);
    }

    fn clear_captures(&mut self, from: u32, to: u32, captures: &mut [i32]) {
        let first = from * 2;
        for (slot, value) in (first..).zip(&mut captures[first as usize..(to * 2) as usize]) {
            if *value != -1 {
                self.stack.push(Frame::Capture { slot, old: *value });
                *value = -1;
            }
        }
    }

    /// Pops every frame above `base`, applying the undo records.
    fn unwind(&mut self, base: usize, captures: &mut [i32]) {
        while self.stack.len() > base {
            match self.stack.pop().expect("a frame above the base") {
                Frame::Capture { slot, old } => captures[slot as usize] = old,
                Frame::Loop { reg, count, start } => self.loops[reg as usize] = (count, start),
                _ => {}
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn match_backref(&self, program: &Program, input: &[u16], groups: u32, ignore_case: bool, back: bool, pos: usize, captures: &[i32]) -> Option<usize> {
        let group = program.backref_groups[groups as usize].iter().find(|&&g| captures[g as usize * 2] >= 0 && captures[g as usize * 2 + 1] >= 0);
        let Some(&group) = group else { return Some(pos) };
        let start = captures[group as usize * 2] as usize;
        let end = captures[group as usize * 2 + 1] as usize;
        let len = end - start;
        if !ignore_case {
            if back {
                if pos < len || input[pos - len..pos] != input[start..end] {
                    return None;
                }
                return Some(pos - len);
            }
            if pos + len > input.len() || input[pos..pos + len] != input[start..end] {
                return None;
            }
            return Some(pos + len);
        }
        // Compare code point by code point after case folding.
        if back {
            let mut left = end;
            let mut right = pos;
            while left > start {
                let (x, next_a) = prev_char(input, left)?;
                let (y, next_b) = prev_char(input, right)?;
                if super::charset::fold(x) != super::charset::fold(y) {
                    return None;
                }
                left = next_a;
                right = next_b;
            }
            Some(right)
        } else {
            let mut left = start;
            let mut right = pos;
            while left < end {
                let (x, next_a) = next_char(input, left)?;
                let (y, next_b) = next_char(input, right)?;
                if super::charset::fold(x) != super::charset::fold(y) {
                    return None;
                }
                left = next_a;
                right = next_b;
            }
            Some(right)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Matcher;
    use crate::regex::{EmulationOptions, JsRegExp};

    #[test]
    fn remembers_where_a_required_literal_is_missing() {
        // Searching a long line for a keyword it lacks, from every token, must not
        // rescan the line each time (that made long lines quadratic).
        let regex = JsRegExp::new("\\btypeof\\b", "dgv", &EmulationOptions::default()).expect("regex");
        let input: Vec<u16> = "\"item\", ".repeat(2000).encode_utf16().collect();
        let mut matcher = Matcher::default();
        matcher.set_input_id(Some(1));
        let (mut raw, mut result) = (Vec::new(), Vec::new());
        for start in (0..input.len()).step_by(8) {
            assert!(!regex.exec_bounded(&mut matcher, &input, start, start + 2, &mut raw, &mut result));
        }
        let scans: Vec<_> = matcher.literal_scans.values().collect();
        assert_eq!(scans.len(), 1);
        assert_eq!((scans[0].from, scans[0].next), (0, None), "one scan, from the first search");
        // A different input id is a different input.
        matcher.set_input_id(Some(2));
        let other: Vec<u16> = "x typeof y".encode_utf16().collect();
        assert!(regex.exec(&mut matcher, &other, 0, &mut raw, &mut result));
    }
}

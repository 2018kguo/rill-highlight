//! One stable merge sort for the whole crate. `slice::sort_by` is instantiated per
//! element type and comparator, and its five instances took 43 KB of the wasm
//! module; this sorts indices with a comparator behind `dyn` (one copy), then
//! moves the elements into that order. The sorts here are of grammar, theme and
//! character-class data, never of input-sized data.

use std::cmp::Ordering;

/// Sorts `items` stably by `compare`, as `slice::sort_by` (and JavaScript's
/// `Array.prototype.sort`) do.
pub fn sort_by<T>(items: &mut Vec<T>, compare: impl Fn(&T, &T) -> Ordering) {
    if items.len() < 2 {
        return;
    }
    let order = sorted_indices(items.len(), &|a, b| compare(&items[a], &items[b]));
    let mut slots: Vec<Option<T>> = items.drain(..).map(Some).collect();
    items.extend(order.into_iter().map(|index| slots[index as usize].take().expect("each index once")));
}

/// The indices `0..len` in stable sorted order.
fn sorted_indices(len: usize, compare: &dyn Fn(usize, usize) -> Ordering) -> Vec<u32> {
    let mut order: Vec<u32> = (0..len as u32).collect();
    let mut scratch = vec![0u32; len];
    let mut width = 1;
    while width < len {
        let mut start = 0;
        while start < len {
            let middle = (start + width).min(len);
            let end = (start + 2 * width).min(len);
            let (mut left, mut right) = (start, middle);
            for slot in &mut scratch[start..end] {
                // Take from the right only when it is strictly smaller: stable.
                let take_right = left == middle || (right < end && compare(order[right] as usize, order[left] as usize) == Ordering::Less);
                if take_right {
                    *slot = order[right];
                    right += 1;
                } else {
                    *slot = order[left];
                    left += 1;
                }
            }
            start = end;
        }
        std::mem::swap(&mut order, &mut scratch);
        width *= 2;
    }
    order
}

#[cfg(test)]
mod tests {
    #[test]
    fn sorts_stably() {
        for len in 0..40usize {
            let mut items: Vec<(u32, usize)> = (0..len).map(|i| ((i * 7919 % 5) as u32, i)).collect();
            let mut want = items.clone();
            want.sort_by_key(|item| item.0);
            super::sort_by(&mut items, |a, b| a.0.cmp(&b.0));
            assert_eq!(items, want);
        }
    }
}

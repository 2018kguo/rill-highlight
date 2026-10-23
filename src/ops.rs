//! An operation counter for the doubling tests (tests/doubling.rs): with the
//! `op-counts` feature, the regex VM and the tokenizer add the work they do
//! (instructions run, frames popped, code units scanned or copied, scope stack
//! nodes walked), so a test can check that work grows linearly with the input
//! without timing it. Without the feature, counting compiles to nothing.

#[cfg(feature = "op-counts")]
thread_local! {
    static OPERATIONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Adds `n` operations.
#[inline(always)]
#[allow(unused_variables)]
pub(crate) fn add(n: usize) {
    #[cfg(feature = "op-counts")]
    OPERATIONS.set(OPERATIONS.get() + n as u64);
}

/// The operations counted on this thread so far (always 0 without the
/// `op-counts` feature).
#[must_use]
pub fn operations() -> u64 {
    #[cfg(feature = "op-counts")]
    return OPERATIONS.get();
    #[cfg(not(feature = "op-counts"))]
    0
}

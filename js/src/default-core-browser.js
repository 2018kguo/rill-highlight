// The default core in browsers: the wasm module fetched from the package's dist/
// directory, located with `new URL(..., import.meta.url)` (which bundlers such as
// Vite and webpack resolve to an emitted asset), and the grammars and themes from
// dist/data/, a table of dynamic imports every bundler splits into chunks.
import { data } from '../dist/data/index.js';
import { createHighlightCore } from './core.js';

let core;

export function getDefaultCore() {
  core ??= createHighlightCore({ wasm: fetch(new URL('../dist/rill_highlight.wasm', import.meta.url)), data });
  return core;
}

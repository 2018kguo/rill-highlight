// The default core in Node: the wasm module from the package's dist/ directory,
// the grammars and themes from dist/data/.
import { readFile } from 'node:fs/promises';
import { data } from '../dist/data/index.js';
import { createHighlightCore } from './core.js';

let core;

export function getDefaultCore() {
  core ??= createHighlightCore({ wasm: readFile(new URL('../dist/rill_highlight.wasm', import.meta.url)), data });
  return core;
}

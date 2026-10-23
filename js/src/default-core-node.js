// The default core in Node: the wasm module and data files from the package's
// dist/ directory.
import { readFile } from 'node:fs/promises';
import { createHighlightCore } from './core.js';

const dist = new URL('../dist/', import.meta.url);
let core;

export function getDefaultCore() {
  core ??= createHighlightCore({
    wasm: readFile(new URL('rill_highlight.wasm', dist)),
    data: {
      grammar: (name) => readFile(new URL(`grammars/${name}.json`, dist), 'utf8'),
      theme: (name) => readFile(new URL(`themes/${name}.json`, dist), 'utf8'),
    },
  });
  return core;
}

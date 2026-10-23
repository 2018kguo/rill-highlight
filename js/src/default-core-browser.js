// The default core in browsers: the wasm module and data files fetched from the
// package's dist/ directory, located with `new URL(..., import.meta.url)` (which
// bundlers such as Vite and webpack resolve to emitted assets).
import { createHighlightCore } from './core.js';

const fetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[rill-highlight] ${response.status} fetching ${url}`);
  return response.text();
};
let core;

export function getDefaultCore() {
  core ??= createHighlightCore({
    wasm: fetch(new URL('../dist/rill_highlight.wasm', import.meta.url)),
    data: {
      grammar: (name) => fetchText(new URL(`../dist/grammars/${name}.json`, import.meta.url)),
      theme: (name) => fetchText(new URL(`../dist/themes/${name}.json`, import.meta.url)),
    },
  });
  return core;
}

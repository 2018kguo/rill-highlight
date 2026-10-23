// @2018kguo/rill-highlight/data: the bundled grammars and themes as
// createHighlightCore's `data`, for a core whose wasm module comes from
// somewhere else:
//
//   import { createHighlightCore } from '@2018kguo/rill-highlight/core';
//   import { data } from '@2018kguo/rill-highlight/data';
//   const core = await createHighlightCore({ wasm: new URL('/assets/rill_highlight.wasm', location.href), data });
export { data } from '../dist/data/index.js';

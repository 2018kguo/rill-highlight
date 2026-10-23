// The environment-independent core: instantiates the wasm module and loads the
// precompiled grammars and themes through a data source.
//
//   const core = await createHighlightCore({ wasm, data });
//   const highlighter = await core.createHighlighter({ themes: ['github-dark'], langs: ['ts'] });
//
// `wasm`: a WebAssembly.Module, ArrayBuffer/Uint8Array, Response, or URL/string
// (or a promise of one).
// `data`: { grammar(name), theme(name) }, each returning the JSON text (or a
// promise of it) of dist/grammars/<name>.json and dist/themes/<name>.json.
// Instead of `wasm` and `data`, `baseUrl` points at a hosted copy of dist/.
import manifest from '../dist/manifest.js';
import { createHighlighterWithCore } from './highlighter.js';

async function instantiate(wasm) {
  wasm = await wasm;
  if (wasm instanceof WebAssembly.Module) return WebAssembly.instantiate(wasm, {});
  if (typeof Response !== 'undefined' && wasm instanceof Response) wasm = await wasm.arrayBuffer();
  else if (wasm instanceof URL || typeof wasm === 'string') wasm = await (await fetch(wasm)).arrayBuffer();
  return (await WebAssembly.instantiate(wasm, {})).instance;
}

/** Fetches dist/ files from `baseUrl`. */
export function dataFromBaseUrl(baseUrl) {
  const base = new URL(baseUrl, typeof location === 'undefined' ? undefined : location.href);
  const text = async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`[rill-highlight] ${response.status} fetching ${response.url}`);
    return response.text();
  };
  return {
    wasm: new URL('rill_highlight.wasm', base),
    data: { grammar: (name) => text(`grammars/${name}.json`), theme: (name) => text(`themes/${name}.json`) },
  };
}

/** The wasm exports as JavaScript functions (see src/wasm.rs). */
function bind(exports) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const text = (length) => decoder.decode(new Uint8Array(exports.memory.buffer, exports.rhl_text(), length));
  const error = () => new Error(`[rill-highlight] ${text(exports.rhl_text_len())}`);
  const withBytes = (bytes, use) => {
    const pointer = exports.rhl_alloc(bytes.length);
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    try {
      return use(pointer, bytes.length);
    } finally {
      exports.rhl_free(pointer, bytes.length);
    }
  };
  const withString = (string, use) => withBytes(encoder.encode(string), use);
  let code = { pointer: 0, units: 0 };

  return {
    newRegistry: () => exports.rhl_registry_new(),
    freeRegistry: (registry) => exports.rhl_registry_free(registry),
    addGrammar(registry, json) {
      if (!withString(json, (pointer, length) => exports.rhl_registry_add_grammar(registry, pointer, length))) throw error();
    },
    /** Returns [handle, [name, type, fg, bg, colorReplacements]]. */
    newTheme(json) {
      const handle = withString(json, (pointer, length) => exports.rhl_theme_new(pointer, length));
      if (!handle) throw error();
      return [handle, JSON.parse(text(exports.rhl_text_len()))];
    },
    freeTheme: (theme) => exports.rhl_theme_free(theme),
    newHighlighter(registry, name, themeHandles) {
      const handles = new Uint8Array(new Uint32Array(themeHandles).buffer);
      const handle = withString(name, (namePointer, nameLength) =>
        withBytes(handles, (themesPointer) => exports.rhl_highlighter_new(registry, namePointer, nameLength, themesPointer, themeHandles.length)),
      );
      if (!handle) throw error();
      return handle;
    },
    freeHighlighter: (highlighter) => exports.rhl_highlighter_free(highlighter),
    /**
     * Tokenizes `string` after state handle `state` (0: initial). Returns
     * [state handle, numbers, style count]: numbers are the line count, then
     * per line the token count followed by offset, length and style id per
     * token; the style count is the highlighter's after this call.
     */
    tokenize(highlighter, string, state, maxLineLength) {
      if (code.units < string.length) {
        if (code.pointer) exports.rhl_free(code.pointer, code.units * 2);
        const units = Math.max(string.length, code.units * 2, 1024);
        code = { pointer: exports.rhl_alloc(units * 2), units };
      }
      const units = new Uint16Array(exports.memory.buffer, code.pointer, string.length);
      for (let index = 0; index < string.length; index++) units[index] = string.charCodeAt(index);
      const out = exports.rhl_tokenize(highlighter, code.pointer, string.length, state, maxLineLength);
      if (!out) throw error();
      const header = new Uint32Array(exports.memory.buffer, out, 3);
      // A copy: later calls may grow the memory, which detaches a view.
      const numbers = new Uint32Array(exports.memory.buffer, out + 12, header[1] - 1).slice();
      return [header[0], numbers, header[2]];
    },
    freeState: (state) => exports.rhl_state_free(state),
    stateScopes: (state) => JSON.parse(text(exports.rhl_state_scopes(state))),
    /** Per style id from `from`: per theme [color or null, font style]. */
    styles: (highlighter, from) => JSON.parse(text(exports.rhl_styles(highlighter, from))),
  };
}

export async function createHighlightCore(options = {}) {
  let { wasm, data } = options;
  if (options.baseUrl !== undefined) ({ wasm, data } = dataFromBaseUrl(options.baseUrl));
  if (!wasm || !data) throw new Error('[rill-highlight] createHighlightCore needs `wasm` and `data`, or `baseUrl`');
  const binding = bind((await instantiate(wasm)).exports);
  const grammarTexts = new Map();
  const themeTexts = new Map();
  const cached = (cache, load) => (name) => {
    if (!cache.has(name)) {
      const promise = Promise.resolve(load(name));
      promise.catch(() => cache.delete(name));
      cache.set(name, promise);
    }
    return cache.get(name);
  };
  const core = {
    manifest,
    binding,
    /** The JSON text of a bundled grammar, loaded once. */
    grammarText: cached(grammarTexts, (name) => data.grammar(name)),
    /** The JSON text of a bundled theme, loaded once. */
    themeText: cached(themeTexts, (name) => data.theme(name)),
    /** A Shiki-compatible highlighter (see highlighter.js). */
    createHighlighter: (highlighterOptions = {}) => createHighlighterWithCore(core, highlighterOptions),
  };
  return core;
}
export { GrammarState, ShikiError } from './highlighter.js';

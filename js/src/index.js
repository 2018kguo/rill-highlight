// @2018kguo/rill-highlight: Shiki's `createHighlighter`, `codeToHtml` and
// `codeToTokens`, highlighting with rill-highlight's wasm tokenizer.
import { getDefaultCore } from '#default-core';
import { createShorthands } from './highlighter.js';

export { createHighlightCore, dataFromBaseUrl } from './core.js';
export { GrammarState, ShikiError, getTokenStyleObject, guessEmbeddedLanguages, splitLines, stringifyTokenStyle } from './highlighter.js';

/** Shiki's `createHighlighter`: loads `themes` and `langs`, then highlights synchronously. */
export async function createHighlighter(options = {}) {
  return (await getDefaultCore()).createHighlighter(options);
}

export const { codeToHtml, codeToTokens, codeToTokensBase, codeToTokensWithThemes, getSingletonHighlighter } = createShorthands(createHighlighter);

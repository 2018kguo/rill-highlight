// Times rill-highlight (wasm in Node) on one language (fresh process), like
// shiki-one.mjs: startup = instantiating the wasm module (once per process);
// cold = createHighlighter + first codeToTokens; warm = codeToTokens.
import { readFileSync } from 'node:fs';
import { getDefaultCore } from '../src/default-core-node.js';
import { createHighlighter } from '../src/index.js';
const [lang, ...files] = process.argv.slice(2);
const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
const options = { lang, themes: { light: 'github-light', dark: 'github-dark' } };
const start = performance.now();
await getDefaultCore();
const startupMs = performance.now() - start;
const t0 = performance.now();
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: [lang] });
highlighter.codeToTokens(code, options);
const coldMs = performance.now() - t0;
// The minimum of several runs after warming up: the machine may be shared.
for (let i = 0; i < 3; i++) highlighter.codeToTokens(code, options);
let warmMs = Infinity;
for (let i = 0; i < 9; i++) {
  const t = performance.now();
  highlighter.codeToTokens(code, options);
  warmMs = Math.min(warmMs, performance.now() - t);
}
let htmlMs = Infinity;
for (let i = 0; i < 9; i++) {
  const t = performance.now();
  highlighter.codeToHtml(code, options);
  htmlMs = Math.min(htmlMs, performance.now() - t);
}
console.log(JSON.stringify({ lang, startupMs, coldMs, warmMs, htmlMs }));

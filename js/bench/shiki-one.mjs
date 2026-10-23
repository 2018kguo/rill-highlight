// Times Shiki as @streamdown/code sets it up (JavaScript regex engine, two
// themes) on one language in a fresh process: cold = createHighlighter + first
// codeToTokens; warm = codeToTokens of the same code; html = codeToHtml.
import { readFileSync } from 'node:fs';
import { createHighlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
const [lang, ...files] = process.argv.slice(2);
const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
const t0 = performance.now();
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: [lang], engine: createJavaScriptRegexEngine({ forgiving: true }) });
const options = { lang, themes: { light: 'github-light', dark: 'github-dark' } };
highlighter.codeToTokens(code, options);
const coldMs = performance.now() - t0;
// The minimum of several runs after warming up: the machine may be shared.
for (let i = 0; i < 3; i++) { highlighter.codeToTokens(code, options); }
let warmMs = Infinity;
for (let i = 0; i < 9; i++) { const t = performance.now(); highlighter.codeToTokens(code, options); warmMs = Math.min(warmMs, performance.now() - t); }
let htmlMs = Infinity;
for (let i = 0; i < 9; i++) { const t = performance.now(); highlighter.codeToHtml(code, options); htmlMs = Math.min(htmlMs, performance.now() - t); }
console.log(JSON.stringify({ lang, coldMs, warmMs, htmlMs }));

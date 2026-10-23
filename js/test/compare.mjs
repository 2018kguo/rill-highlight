// Differential test: dual-theme tokens (github-light / github-dark, as Streamdown
// asks for them) from rill-highlight's codeToTokens vs @streamdown/code's
// (Shiki 4.5.0 on its JavaScript regex engine), per corpus file: token
// boundaries, offsets and htmlStyle, compared as JSON.
//   node test/compare.mjs [--ci] [LANG...]
// The reference runs one Node process per file: V8's RegExp tier-up can return
// wrong results for case-insensitive modifier groups after enough work in one
// process, which would make the reference itself depend on what ran before.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHighlighter } from '../src/index.js';
import { corpusEntries, languagesOf } from './corpus.mjs';

const here = new URL('..', import.meta.url).pathname;
const entries = corpusEntries();
const themes = { light: 'github-light', dark: 'github-dark' };
let allExact = true;
const summary = [];
for (const lang of languagesOf(entries)) {
  const files = entries.filter((entry) => entry.lang === lang).map((entry) => entry.path);
  const highlighter = await createHighlighter({ themes: Object.values(themes), langs: [lang] });
  let lines = 0, tokens = 0, badLines = 0, shown = 0;
  for (const file of files) {
    const want = JSON.parse(execFileSync('node', [here + 'test/reference.mjs', lang, file], { maxBuffer: 1 << 30 }).toString());
    const result = highlighter.codeToTokens(readFileSync(file, 'utf8'), { lang, themes });
    const got = result.tokens.map((line) => line.map((token) => [token.content, token.offset, token.htmlStyle]));
    for (const key of ['fg', 'bg', 'themeName']) if (want[key] !== result[key]) { console.log(`${lang}: ${key} ${result[key]} != ${want[key]}`); badLines++; }
    for (let line = 0; line < Math.max(want.tokens.length, got.length); line++) {
      lines++;
      tokens += want.tokens[line]?.length ?? 0;
      const a = JSON.stringify(want.tokens[line]), b = JSON.stringify(got[line]);
      if (a !== b) {
        badLines++;
        if (shown++ < 3) console.log(`${lang} ${file.split('/').pop()}:${line + 1}\n  want ${a?.slice(0, 600)}\n  got  ${b?.slice(0, 600)}`);
      }
    }
  }
  highlighter.dispose();
  if (badLines) allExact = false;
  summary.push({ lang, files: files.length, lines, tokens, mismatchedLines: badLines });
  console.log(JSON.stringify(summary.at(-1)));
}
console.table(summary);
const total = (key) => summary.reduce((sum, row) => sum + row[key], 0);
console.log(`tokens: ${total('files')} files, ${total('lines')} lines, ${total('tokens')} tokens, ${total('mismatchedLines')} mismatched lines`);
process.exit(allExact ? 0 : 1);

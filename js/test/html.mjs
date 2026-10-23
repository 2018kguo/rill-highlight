// Differential test: rill-highlight's codeToHtml vs Shiki 4.5.0's, byte for
// byte, per corpus file and option set (test/html-modes.mjs: one theme, two
// themes, CSS variables, three themes, light-dark(), the merge, structure and
// line-length options).
//   node test/html.mjs [--ci] [LANG...]
//   ENGINE=oniguruma node test/html.mjs    (compare with Shiki's default engine)
// One reference process per file (see compare.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHighlighter } from '../src/index.js';
import { corpusEntries, languagesOf, referenceFlags } from './corpus.mjs';
import { EXTRA_MAX_LINES, modes, themesOf } from './html-modes.mjs';

const here = new URL('..', import.meta.url).pathname;
const entries = corpusEntries();
const summary = [];
for (const lang of languagesOf(entries)) {
  const highlighter = await createHighlighter({ themes: themesOf(modes(lang)), langs: [lang] });
  let calls = 0, identical = 0, bytes = 0, shown = 0;
  for (const { path } of entries.filter((entry) => entry.lang === lang)) {
    const code = readFileSync(path, 'utf8');
    const want = JSON.parse(execFileSync('node', [...referenceFlags, here + 'test/html-reference.mjs', lang, path], { maxBuffer: 1 << 30 }).toString());
    const list = modes(lang).slice(0, code.split('\n').length <= EXTRA_MAX_LINES ? undefined : 2);
    list.forEach((options, index) => {
      let got;
      try {
        got = highlighter.codeToHtml(code, options);
      } catch (error) {
        got = { error: String(error) };
      }
      calls++;
      const a = JSON.stringify(want[index]), b = JSON.stringify(got);
      bytes += a.length;
      if (a === b) return identical++;
      if (shown++ < 2) {
        let at = 0;
        while (a[at] === b[at]) at++;
        console.log(`${lang} ${path.split('/').pop()} ${JSON.stringify(options)} differs at ${at}:\n  want …${a.slice(Math.max(0, at - 80), at + 160)}\n  got  …${b.slice(Math.max(0, at - 80), at + 160)}`);
      }
    });
  }
  highlighter.dispose();
  summary.push({ lang, calls, identical, mismatches: calls - identical, kb: Math.round(bytes / 1024) });
  console.log(JSON.stringify(summary.at(-1)));
}
console.table(summary);
const total = (key) => summary.reduce((sum, row) => sum + row[key], 0);
console.log(`html: ${total('calls')} codeToHtml calls, ${total('identical')} byte-identical, ${total('mismatches')} different (${total('kb')} KB of reference HTML)`);
process.exit(total('mismatches') ? 1 : 0);

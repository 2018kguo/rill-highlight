// Every bundled language on a mixed sample (the first lines of several corpus
// files, so each grammar sees code it was and was not written for):
// rill-highlight's dual-theme tokens and single-theme HTML vs Shiki's.
//   node test/all-languages.mjs [LANG...]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { bundledLanguagesInfo } from 'shiki';
import { createHighlighter } from '../src/index.js';
import { referenceFlags } from './corpus.mjs';

const here = new URL('..', import.meta.url).pathname;
const index = JSON.parse(readFileSync(here + 'corpus/files/index.json', 'utf8'));
const sampleLangs = ['typescript', 'python', 'c', 'html', 'markdown', 'shellscript', 'ruby', 'json', 'yaml', 'sql'];
const sample = sampleLangs.map((l) => readFileSync(here + 'corpus/files/' + index.find((e) => e.lang === l).file, 'utf8').split('\n').slice(0, 40).join('\n')).join('\n');
mkdirSync(here + 'scratch', { recursive: true });
const samplePath = here + 'scratch/mixed-sample.txt';
writeFileSync(samplePath, sample);
const wanted = process.argv.slice(2);
const ids = bundledLanguagesInfo.map((i) => i.id).filter((id) => !wanted.length || wanted.includes(id));
const themes = { light: 'github-light', dark: 'github-dark' };
const results = { exact: [], mismatch: [], error: [] };
for (const id of ids) {
  let got, want, html;
  try {
    want = JSON.parse(execFileSync('node', [...referenceFlags, here + 'test/reference.mjs', id, samplePath], { maxBuffer: 1 << 30 }).toString());
    const highlighter = await createHighlighter({ themes: Object.values(themes), langs: [id] });
    got = highlighter.codeToTokens(sample, { lang: id, themes }).tokens.map((line) => line.map((t) => [t.content, t.offset, t.htmlStyle]));
    html = [highlighter.codeToHtml(sample, { lang: id, theme: 'github-dark' }), execFileSync('node', [...referenceFlags, '-e', `import('shiki').then(async ({ createHighlighter, createJavaScriptRegexEngine }) => { const h = await createHighlighter({ themes: ['github-dark'], langs: [${JSON.stringify(id)}], engine: createJavaScriptRegexEngine({ forgiving: true }) }); process.stdout.write(h.codeToHtml(require('fs').readFileSync(${JSON.stringify(samplePath)}, 'utf8'), { lang: ${JSON.stringify(id)}, theme: 'github-dark' })); })`], { maxBuffer: 1 << 30 }).toString()];
    highlighter.dispose();
  } catch (error) {
    results.error.push(`${id}: ${String(error).slice(0, 200)}`);
    process.stderr.write('E');
    continue;
  }
  const bad = want.tokens.findIndex((line, i) => JSON.stringify(line) !== JSON.stringify(got[i]));
  if (bad === -1 && want.tokens.length === got.length && html[0] === html[1]) results.exact.push(id);
  else results.mismatch.push(bad === -1 ? `${id}: html differs` : `${id} line ${bad + 1}: want ${JSON.stringify(want.tokens[bad])?.slice(0, 300)} got ${JSON.stringify(got[bad])?.slice(0, 300)}`);
  process.stderr.write(bad === -1 ? '.' : 'x');
}
console.log(`\nexact ${results.exact.length}/${ids.length} (tokens and HTML)`);
console.log('MISMATCH\n' + results.mismatch.join('\n'));
console.log('ERROR\n' + results.error.join('\n'));
process.exit(results.mismatch.length || results.error.length ? 1 : 0);

// The test corpus: corpus/files (fetched by `npm run corpus`) and corpus/edge
// (checked in). `--ci` keeps only corpus/edge, which needs no network.
import { existsSync, readFileSync } from 'node:fs';

const here = new URL('..', import.meta.url).pathname;

export const ci = process.argv.includes('--ci');

// Node flags for the processes that run Shiki as the reference: tokenize every
// line to the end, so the reference does not depend on the machine's speed
// (test/no-time-limit.mjs).
export const referenceFlags = ['--import', here + 'test/no-time-limit.mjs'];
export const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));

const read = (dir) => (existsSync(here + dir + 'index.json') ? JSON.parse(readFileSync(here + dir + 'index.json', 'utf8')).map((entry) => ({ lang: entry.lang, path: here + dir + entry.file })) : []);

/** [{ lang, path }] of the corpus, filtered by the LANG arguments. */
export function corpusEntries() {
  const entries = [...(ci ? [] : read('corpus/files/')), ...read('corpus/edge/')];
  if (!ci && !existsSync(here + 'corpus/files/index.json')) console.warn('corpus/files is missing: run `npm run corpus` (testing corpus/edge only)');
  return entries.filter((entry) => !wanted.length || wanted.includes(entry.lang));
}

/** The corpus languages, in corpus order. */
export const languagesOf = (entries) => [...new Set(entries.map((entry) => entry.lang))];

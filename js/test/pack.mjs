// Packs the npm package, installs the tarball into a temporary project, and
// highlights from it in a fresh Node process: the published files are enough.
//   node test/pack.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHighlighter } from '../src/index.js';

const here = new URL('..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'rill-highlight-pack-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: here }).toString());
  console.log(`${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1e6).toFixed(2)} MB packed, ${(packed.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
  const project = join(temp, 'project');
  execFileSync('mkdir', [project]);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(temp, packed.filename)], { cwd: project, stdio: 'inherit' });
  const code = 'fn main() {\n    println!("<&>");\n}\n';
  writeFileSync(
    join(project, 'run.mjs'),
    `import { codeToHtml, createHighlighter } from '@2018kguo/rill-highlight';
import { createHighlightCore } from '@2018kguo/rill-highlight/core';
import { code } from '@2018kguo/rill-highlight/streamdown';
const source = ${JSON.stringify(code)};
const single = await codeToHtml(source, { lang: 'rust', theme: 'github-dark' });
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: ['rust'] });
const dual = highlighter.codeToHtml(source, { lang: 'rust', themes: { light: 'github-light', dark: 'github-dark' } });
const streamed = await new Promise((resolve) => {
  const result = code.highlight({ code: source, language: 'rs', themes: ['github-light', 'github-dark'] }, resolve);
  if (result) resolve(result);
});
console.log(JSON.stringify({ single, dual, tokens: streamed.tokens.flat().length, core: typeof createHighlightCore }));
`,
  );
  const got = JSON.parse(execFileSync('node', ['run.mjs'], { cwd: project }).toString());
  const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: ['rust'] });
  const want = {
    single: highlighter.codeToHtml(code, { lang: 'rust', theme: 'github-dark' }),
    dual: highlighter.codeToHtml(code, { lang: 'rust', themes: { light: 'github-light', dark: 'github-dark' } }),
  };
  if (got.single !== want.single || got.dual !== want.dual || !(got.tokens >= 8) || got.core !== 'function') {
    console.error('installed package output differs', got, want);
    process.exit(1);
  }
  console.log('installed package highlights in Node: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

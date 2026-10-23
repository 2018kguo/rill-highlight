// Bundler smoke test: packs the npm package, installs the tarball into a temporary
// project, bundles a page that highlights on the main thread and in a Web Worker
// (createHighlighter and the Streamdown plugin) with Vite and with `bun build`, and
// loads each build in headless Chromium: the HTML and tokens must be Node's, the
// wasm module must be fetched, and each grammar must arrive in a chunk of its own.
//   node test/bundle.mjs            (needs bun on PATH for the bun build)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { createHighlighter } from '../src/index.js';
import { code as nodePlugin } from '../src/streamdown.js';

const here = new URL('..', import.meta.url).pathname;
const SOURCE = 'fn main() {\n    let answer: u32 = 42; // "<&>"\n    println!("{answer}");\n}\n';
const THEMES = ['github-light', 'github-dark'];

// What the page computes, in Node.
async function expected() {
  const highlighter = await createHighlighter({ themes: THEMES, langs: ['rust'] });
  const html = highlighter.codeToHtml(SOURCE, { lang: 'rust', themes: { light: THEMES[0], dark: THEMES[1] } });
  const streamed = await new Promise((resolve) => {
    const result = nodePlugin.highlight({ code: SOURCE, language: 'py', themes: THEMES }, resolve);
    if (result) resolve(result);
  });
  return { html, tokens: JSON.stringify(streamed.tokens) };
}

// The page: `core` is how the package's wasm module is found (bun does not turn
// `new URL(..., import.meta.url)` in a dependency into an asset).
const page = (core) => `import { createHighlighter } from '@2018kguo/rill-highlight';
import { createHighlightCore } from '@2018kguo/rill-highlight/core';
import { data } from '@2018kguo/rill-highlight/data';
import { code, createCodePlugin } from '@2018kguo/rill-highlight/streamdown';

const core = ${core === 'default' ? 'null' : "createHighlightCore({ wasm: new URL('./rill_highlight.wasm', import.meta.url), data })"};
export async function highlightAll(source) {
  const themes = ${JSON.stringify(THEMES)};
  const highlighter = await (core ? (await core).createHighlighter({ themes, langs: ['rust'] }) : createHighlighter({ themes, langs: ['rust'] }));
  const html = highlighter.codeToHtml(source, { lang: 'rust', themes: { light: themes[0], dark: themes[1] } });
  const plugin = core ? createCodePlugin({ core }) : code;
  const streamed = await new Promise((resolve) => {
    const result = plugin.highlight({ code: source, language: 'py', themes }, resolve);
    if (result) resolve(result);
  });
  return { html, tokens: JSON.stringify(streamed.tokens) };
}
`;
const main = `import { highlightAll } from './page.js';
const source = ${JSON.stringify(SOURCE)};
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const fromWorker = new Promise((resolve, reject) => {
  worker.onmessage = (event) => resolve(event.data);
  worker.onerror = (event) => reject(new Error(event.message));
});
worker.postMessage(source);
window.result = Promise.all([highlightAll(source), fromWorker]).then(([main, worker]) => ({ main, worker }), (error) => ({ error: String(error) }));
`;
const worker = `import { highlightAll } from './page.js';
self.onmessage = async (event) => self.postMessage(await highlightAll(event.data));
`;

const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.css': 'text/css' };
function serve(root) {
  const server = createServer((request, response) => {
    const path = join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    try {
      const body = readFileSync(path.endsWith('/') ? join(path, 'index.html') : path);
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Loads the build in `root` and returns what the page computed and fetched. */
async function run(browser, root, entry) {
  const server = await serve(root);
  const context = await browser.newContext();
  const fetched = [];
  context.on('response', async (response) => {
    const url = response.url();
    const body = url.endsWith('.js') ? await response.text().catch(() => '') : '';
    fetched.push({ url, status: response.status(), body });
  });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(String(error)));
  await tab.goto(`http://127.0.0.1:${server.address().port}/${entry}`);
  const result = await tab.evaluate(() => window.result);
  await context.close();
  server.close();
  return { result, fetched, errors };
}

function check(name, { result, fetched, errors }, want) {
  assert.deepEqual(errors, [], `${name}: page errors`);
  assert.ok(!result.error, `${name}: ${result.error}`);
  for (const thread of ['main', 'worker']) {
    assert.equal(result[thread].html, want.html, `${name} ${thread}: codeToHtml differs from Node`);
    assert.equal(result[thread].tokens, want.tokens, `${name} ${thread}: plugin tokens differ from Node`);
  }
  assert.ok(fetched.some((file) => file.url.endsWith('.wasm') && file.status === 200), `${name}: no wasm fetched`);
  const missing = fetched.filter((file) => file.status !== 200);
  assert.deepEqual(missing.map((file) => file.url), [], `${name}: failed requests`);
  // Each grammar comes in a chunk of its own, not in the page's bundle.
  for (const scope of ['source.rust', 'source.python']) {
    const holders = fetched.filter((file) => file.body.includes(scope));
    assert.ok(holders.length > 0, `${name}: no chunk with ${scope}`);
    assert.ok(holders.every((file) => !/(main|worker|page|index)[^/]*\.js$/.test(file.url) && file.body.length < 2e6), `${name}: ${scope} is bundled into ${holders.map((file) => file.url)}`);
  }
  const chunks = fetched.filter((file) => file.url.endsWith('.js')).length;
  console.log(`ok  ${name}: identical HTML and tokens on the main thread and in a worker; ${chunks} scripts, wasm and grammar chunks fetched`);
}

const temp = mkdtempSync(join(tmpdir(), 'rill-highlight-bundle-'));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const want = await expected();
  execFileSync('node', [here + 'scripts/package-files.mjs'], { stdio: 'ignore' });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: here }).toString());
  const project = join(temp, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(temp, packed.filename)], { cwd: project, stdio: 'ignore' });
  writeFileSync(join(project, 'main.js'), main);
  writeFileSync(join(project, 'worker.js'), worker);
  writeFileSync(join(project, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>\n');

  // Vite resolves the package's own `new URL(..., import.meta.url)` assets.
  writeFileSync(join(project, 'page.js'), page('default'));
  await build({ root: project, logLevel: 'silent', build: { outDir: join(temp, 'vite') }, worker: { format: 'es' } });
  check('vite', await run(browser, join(temp, 'vite'), 'index.html'), want);

  // bun: the wasm module is copied next to the bundle and passed in.
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log('skipped bun: not installed');
    process.exit(0);
  }
  writeFileSync(join(project, 'page.js'), page('explicit'));
  const out = join(temp, 'bun');
  execFileSync('bun', ['build', 'main.js', 'worker.js', '--outdir', out, '--target', 'browser', '--splitting', '--minify'], { cwd: project, stdio: 'ignore' });
  copyFileSync(join(project, 'node_modules/@2018kguo/rill-highlight/dist/rill_highlight.wasm'), join(out, 'rill_highlight.wasm'));
  writeFileSync(join(out, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>\n');
  check('bun', await run(browser, out, 'index.html'), want);
} finally {
  await browser.close();
  rmSync(temp, { recursive: true, force: true });
}

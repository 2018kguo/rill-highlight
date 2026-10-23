// Loaded with `node --import` into the processes that run Shiki as the reference
// (see referenceFlags in corpus.mjs). Shiki stops tokenizing a line once it has
// taken tokenizeTimeLimit (500 ms by default, and @streamdown/code passes no
// option) and leaves the rest of the line in the scope it had reached. A cold
// grammar's first line can take that long on a slow or busy machine, because
// the JavaScript engine compiles each pattern on first use, so the reference
// would depend on the machine: on GitHub's runners Shiki's light-theme pass over
// line 2 of corpus/edge/templates.cpp.txt stopped early and its dark-theme pass
// did not. Here every line is tokenized to the end, as rill-highlight does.
import { createHighlighter, createJavaScriptRegexEngine } from 'shiki';

const highlighter = await createHighlighter({ themes: [], langs: ['json'], engine: createJavaScriptRegexEngine() });
// vscode-textmate's Grammar class, shared with every highlighter in the process.
const grammar = Object.getPrototypeOf(highlighter.getLanguage('json'));
highlighter.dispose();
for (const name of ['tokenizeLine', 'tokenizeLine2']) {
  const tokenize = grammar[name];
  if (typeof tokenize !== 'function') throw new Error(`no Grammar.${name} to patch`);
  grammar[name] = function (lineText, prevState) {
    return tokenize.call(this, lineText, prevState, 0);
  };
}

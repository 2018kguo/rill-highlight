// Shiki's `codeToHast` + hast-util-to-html, as string building: the token merges
// of `codeToHast` and the markup `tokensToHast` builds, serialized as
// `toHtml` does with its default options. Tokens here are { content, offset,
// style, fontStyle? }, where `style` is the stringified token style.

const RE_WHITESPACE_ONLY = /^\s+$/;
const RE_LEADING_TRAILING_WHITESPACE = /^(\s*)(.*?)(\s*)$/;
const FONT_UNDERLINE = 4;
const FONT_STRIKETHROUGH = 8;

const isDecorated = (token) => token.fontStyle && (token.fontStyle & FONT_UNDERLINE || token.fontStyle & FONT_STRIKETHROUGH);

/** Shiki `mergeWhitespaceTokens`. */
function mergeWhitespaceTokens(tokens) {
  return tokens.map((line) => {
    const newLine = [];
    let carryOnContent = '';
    let firstOffset;
    line.forEach((token, index) => {
      const couldMerge = !isDecorated(token);
      if (couldMerge && RE_WHITESPACE_ONLY.test(token.content) && line[index + 1]) {
        if (firstOffset === undefined) firstOffset = token.offset;
        carryOnContent += token.content;
      } else if (carryOnContent) {
        if (couldMerge) newLine.push({ ...token, offset: firstOffset, content: carryOnContent + token.content });
        else newLine.push({ content: carryOnContent, offset: firstOffset, style: '' }, token);
        firstOffset = undefined;
        carryOnContent = '';
      } else newLine.push(token);
    });
    return newLine;
  });
}

/** Shiki `splitWhitespaceTokens` (`mergeWhitespaces: 'never'`). */
function splitWhitespaceTokens(tokens) {
  return tokens.map((line) =>
    line.flatMap((token) => {
      if (RE_WHITESPACE_ONLY.test(token.content)) return token;
      const match = token.content.match(RE_LEADING_TRAILING_WHITESPACE);
      if (!match) return token;
      const [, leading, content, trailing] = match;
      if (!leading && !trailing) return token;
      const expanded = [{ ...token, offset: token.offset + leading.length, content }];
      if (leading) expanded.unshift({ content: leading, offset: token.offset, style: '' });
      if (trailing) expanded.push({ content: trailing, offset: token.offset + leading.length + content.length, style: '' });
      return expanded;
    }),
  );
}

/** Shiki `mergeAdjacentStyledTokens` (`mergeSameStyleTokens: true`). */
function mergeAdjacentStyledTokens(tokens) {
  return tokens.map((line) => {
    const newLine = [];
    for (const token of line) {
      if (newLine.length === 0) {
        newLine.push({ ...token });
        continue;
      }
      const previous = newLine.at(-1);
      if (!isDecorated(previous) && !isDecorated(token) && previous.style === token.style) previous.content += token.content;
      else newLine.push({ ...token });
    }
    return newLine;
  });
}

// stringify-entities with hast-util-to-html's default subsets and hexadecimal
// references.
const reference = (character) => `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`;
const escapeText = (text) => (/[<&]/.test(text) ? text.replace(/[<&]/g, reference) : text);
const escapeAttribute = (value) => (/[\0"&'`]/.test(value) ? value.replace(/[\0"&'`]/g, reference) : value);

/**
 * `codeToHtml` from `codeToTokens`' result (tokens, fg, bg, themeName,
 * rootStyle) and the `structure`, `tabindex` and merge options.
 */
export function tokensToHtml(tokens, options) {
  const { mergeWhitespaces = true, mergeSameStyleTokens = false, structure = 'classic', tabindex = '0' } = options;
  if (mergeWhitespaces === true) tokens = mergeWhitespaceTokens(tokens);
  else if (mergeWhitespaces === 'never') tokens = splitWhitespaceTokens(tokens);
  if (mergeSameStyleTokens) tokens = mergeAdjacentStyledTokens(tokens);
  let lines = '';
  for (let index = 0; index < tokens.length; index++) {
    if (index) lines += structure === 'inline' ? '<br>' : structure === 'classic' ? '\n' : '';
    let line = '';
    for (const token of tokens[index]) {
      line += token.style ? `<span style="${escapeAttribute(token.style)}">` : '<span>';
      line += escapeText(token.content) + '</span>';
    }
    lines += structure === 'classic' ? `<span class="line">${line}</span>` : structure === 'inline' ? line : '';
  }
  if (structure !== 'classic') return lines;
  let attributes = ` class="${escapeAttribute(`shiki ${options.themeName || ''}`)}"`;
  if (options.rootStyle !== false) attributes += ` style="${escapeAttribute(String(options.rootStyle != null ? options.rootStyle : `background-color:${options.bg};color:${options.fg}`))}"`;
  if (tabindex !== false && tabindex != null) attributes += ` tabindex="${escapeAttribute(tabindex.toString())}"`;
  return `<pre${attributes}><code>${lines}</code></pre>`;
}

// The codeToHtml option sets test/html.mjs compares, for a language. The first
// two run on every file; the rest on files of up to EXTRA_MAX_LINES lines.
export const EXTRA_MAX_LINES = 400;

export const modes = (lang) => [
  { lang, theme: 'github-dark' },
  { lang, themes: { light: 'github-light', dark: 'github-dark' } },
  { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, cssVariablePrefix: '--code-' },
  { lang, themes: { light: 'one-light', dark: 'one-dark-pro', dim: 'monokai' }, defaultColor: 'dark' },
  { lang, themes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' }, defaultColor: 'light-dark()' },
  { lang, theme: 'one-dark-pro', mergeWhitespaces: 'never', tabindex: false },
  { lang, theme: 'dracula', mergeSameStyleTokens: true, mergeWhitespaces: false, structure: 'inline' },
  { lang, theme: 'solarized-light', tokenizeMaxLineLength: 60, rootStyle: false },
];

export const themesOf = (list) => [...new Set(list.flatMap((mode) => (mode.theme ? [mode.theme] : Object.values(mode.themes))))];

// Types for @2018kguo/rill-highlight/streamdown: @streamdown/code 2.0.0's plugin.
import type { HighlightCore, ThemeInput, ThemedTokenWithStyle } from './core.js';

export interface HighlightOptions {
  code: string;
  language: string;
  themes: [ThemeInput, ThemeInput];
  isIncomplete?: boolean;
}

export interface HighlightResult {
  tokens: ThemedTokenWithStyle[][];
  fg: string;
  bg: string;
  themeName: string;
  rootStyle?: string;
}

export interface CodeHighlighterPlugin {
  name: 'shiki';
  type: 'code-highlighter';
  supportsLanguage(language: string): boolean;
  getSupportedLanguages(): string[];
  getThemes(): [ThemeInput, ThemeInput];
  /** The cached result, or null and a later `callback` call. */
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null;
  /** The result now if the language is loaded, else null (no callback). */
  highlightSync(options: HighlightOptions): HighlightResult | null;
  /** Loads the language's highlighter for `themes`; rejects when it cannot (a theme
   * that is not bundled, a grammar that does not compile). */
  load(options: Pick<HighlightOptions, 'language' | 'themes'>): Promise<void>;
}

export interface CodePluginOptions {
  /** Default `['github-light', 'github-dark']`. */
  themes?: [ThemeInput, ThemeInput];
  /** A core from createHighlightCore, to load the wasm and data from elsewhere. */
  core?: HighlightCore | Promise<HighlightCore>;
}

export declare function createCodePlugin(options?: CodePluginOptions): CodeHighlighterPlugin;
export declare const code: CodeHighlighterPlugin;

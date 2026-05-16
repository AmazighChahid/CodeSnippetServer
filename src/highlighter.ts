import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import { extname } from "node:path";

const LANG_BY_EXT: Record<string, BundledLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(theme: string): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [theme],
      langs: ["typescript", "tsx", "javascript", "jsx"],
    });
  }
  return highlighterPromise;
}

export function languageFor(absolutePath: string): BundledLanguage {
  const ext = extname(absolutePath).toLowerCase();
  return LANG_BY_EXT[ext] ?? "typescript";
}

export async function highlight(
  code: string,
  lang: BundledLanguage,
  theme: string,
): Promise<string> {
  const hl = await getHighlighter(theme);
  return hl.codeToHtml(code, { lang, theme });
}

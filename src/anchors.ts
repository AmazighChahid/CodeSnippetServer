import { Project, SyntaxKind, type SourceFile, type Node } from "ts-morph";
import { extname } from "node:path";

export interface AnchorRange {
  name: string;
  startLine: number;
  endLine: number;
  startLineInSymbol: number;
  endLineInSymbol: number;
}

const ANCHOR_START = /\/\/\s*#region\s+anchor:([a-zA-Z0-9_-]+)/;
const ANCHOR_END = /\/\/\s*#endregion/;

export function isAnchorTagLine(line: string): boolean {
  return ANCHOR_START.test(line) || ANCHOR_END.test(line);
}

/**
 * If the symbol has at least one anchor, return a window from the first
 * `#region anchor:` line to the last `#endregion` line. Otherwise return the
 * full code unchanged. Anchors are returned with positions adjusted to the
 * narrowed window (startLineInSymbol becomes startLineInSymbol within the
 * window). Indentation of the window is also de-indented based on the first
 * non-empty line's leading whitespace.
 */
export function narrowToAnchors(
  fullCode: string,
  anchors: AnchorRange[],
): { code: string; anchors: AnchorRange[]; narrowed: boolean } {
  if (anchors.length === 0) return { code: fullCode, anchors, narrowed: false };

  // Find the first opening tag line and the last closing tag line.
  let firstLine = Infinity;
  let lastLine = -Infinity;
  for (const a of anchors) {
    if (a.startLineInSymbol < firstLine) firstLine = a.startLineInSymbol;
    if (a.endLineInSymbol > lastLine) lastLine = a.endLineInSymbol;
  }

  const lines = fullCode.split("\n");
  if (firstLine < 1 || lastLine > lines.length) {
    return { code: fullCode, anchors, narrowed: false };
  }

  const windowLines = lines.slice(firstLine - 1, lastLine);

  // De-indent: find the minimal leading whitespace among non-empty lines.
  let minIndent = Infinity;
  for (const line of windowLines) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^(\s*)/);
    const indent = m ? m[1].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!isFinite(minIndent)) minIndent = 0;

  const dedented = windowLines.map((l) =>
    l.length >= minIndent ? l.slice(minIndent) : l,
  );

  // Recompute anchor positions relative to the new window.
  const offset = firstLine - 1; // we removed `offset` lines from the top
  const narrowedAnchors: AnchorRange[] = anchors.map((a) => ({
    name: a.name,
    startLine: a.startLine,
    endLine: a.endLine,
    startLineInSymbol: a.startLineInSymbol - offset,
    endLineInSymbol: a.endLineInSymbol - offset,
  }));

  return { code: dedented.join("\n"), anchors: narrowedAnchors, narrowed: true };
}

/**
 * Strip anchor tag lines from a code block. Returns the cleaned code
 * and a per-line array `cleanedLineAnchors[i]` listing the anchor names
 * that contain that cleaned line (for visual highlighting).
 */
export function stripAnchorTags(
  code: string,
  anchors: AnchorRange[],
): { cleaned: string; cleanedLineAnchors: string[][] } {
  const lines = code.split("\n");
  const isTag = lines.map(isAnchorTagLine);

  // Build map from original line index (0-based) to anchor names containing it.
  // Anchor ranges use startLineInSymbol/endLineInSymbol which are 1-based and
  // include the tag lines themselves; we want to mark the content lines, which
  // are between (start+1) and (end-1) inclusive in 1-based, or (start..end-2)
  // in 0-based bounds.
  const originalLineAnchors: string[][] = lines.map(() => []);
  for (const a of anchors) {
    const innerStart = a.startLineInSymbol; // 1-based, the tag line itself
    const innerEnd = a.endLineInSymbol;     // 1-based, the #endregion line
    for (let i = innerStart; i < innerEnd - 1; i++) {
      // i is 0-based index of a content line between the two tags
      if (originalLineAnchors[i]) originalLineAnchors[i].push(a.name);
    }
  }

  const cleanedLines: string[] = [];
  const cleanedLineAnchors: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTag[i]) continue;
    cleanedLines.push(lines[i]);
    cleanedLineAnchors.push(originalLineAnchors[i] ?? []);
  }

  return { cleaned: cleanedLines.join("\n"), cleanedLineAnchors };
}

function makeSourceFile(absolutePath: string, source: string): SourceFile {
  const ext = extname(absolutePath).toLowerCase();
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 4 },
  });
  return project.createSourceFile(`virtual${ext}`, source);
}

function findSymbolNode(sf: SourceFile, symbolName: string): Node | undefined {
  for (const stmt of sf.getStatements()) {
    const named = stmt as Node & { getName?: () => string | undefined };
    try {
      if (typeof named.getName === "function" && named.getName() === symbolName) return stmt;
    } catch { /* ignore */ }
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement);
      for (const decl of vs.getDeclarations()) {
        if (decl.getName() === symbolName) return stmt;
      }
    }
  }
  return undefined;
}

/**
 * Extract anchor ranges scoped to one symbol. Lines are reported both as
 * file-absolute (startLine/endLine) and symbol-relative (startLineInSymbol).
 * Symbol-relative numbering starts at 1 for the first line of the symbol.
 */
export function extractAnchors(
  absolutePath: string,
  source: string,
  symbolName: string,
): AnchorRange[] {
  const sf = makeSourceFile(absolutePath, source);
  const node = findSymbolNode(sf, symbolName);
  if (!node) return [];

  const symbolStartLine = sf.getLineAndColumnAtPos(node.getStart(true)).line;
  const symbolEndLine = sf.getLineAndColumnAtPos(node.getEnd()).line;

  const lines = source.split("\n");
  const anchors: AnchorRange[] = [];
  const stack: { name: string; startLine: number }[] = [];

  for (let i = symbolStartLine - 1; i < symbolEndLine && i < lines.length; i++) {
    const line = lines[i];
    const startMatch = line.match(ANCHOR_START);
    if (startMatch) {
      stack.push({ name: startMatch[1], startLine: i + 1 });
      continue;
    }
    if (ANCHOR_END.test(line) && stack.length > 0) {
      const opened = stack.pop()!;
      anchors.push({
        name: opened.name,
        startLine: opened.startLine,
        endLine: i + 1,
        startLineInSymbol: opened.startLine - symbolStartLine + 1,
        endLineInSymbol: i + 1 - symbolStartLine + 1,
      });
    }
  }

  return anchors;
}

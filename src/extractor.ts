import { Project, ScriptKind, SyntaxKind, type Node, type SourceFile } from "ts-morph";
import { extname } from "node:path";

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface SymbolListEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function scriptKindFor(ext: string): ScriptKind {
  switch (ext) {
    case ".tsx": return ScriptKind.TSX;
    case ".jsx": return ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ScriptKind.JS;
    default: return ScriptKind.TS;
  }
}

function makeSourceFile(absolutePath: string, source: string): SourceFile {
  const ext = extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 4 /* Preserve */ },
  });
  return project.createSourceFile(`virtual${ext}`, source, {
    scriptKind: scriptKindFor(ext),
  });
}

function nodeKindLabel(node: Node): string {
  return SyntaxKind[node.getKind()];
}

function nodeName(node: Node): string | undefined {
  const named = node as Node & { getName?: () => string | undefined };
  if (typeof named.getName === "function") {
    try { return named.getName(); } catch { /* ignore */ }
  }
  return undefined;
}

function findTopLevelSymbol(sf: SourceFile, name: string): Node | undefined {
  for (const stmt of sf.getStatements()) {
    const direct = nodeName(stmt);
    if (direct === name) return stmt;

    // Variable statements: `export const foo = ...`
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement);
      for (const decl of vs.getDeclarations()) {
        if (decl.getName() === name) return stmt;
      }
    }
  }
  return undefined;
}

export function extractSymbol(
  absolutePath: string,
  source: string,
  symbolName: string,
): ExtractedSymbol {
  const sf = makeSourceFile(absolutePath, source);
  const node = findTopLevelSymbol(sf, symbolName);

  if (!node) {
    throw new SymbolNotFoundError(`symbol "${symbolName}" not found in ${absolutePath}`);
  }

  // Include leading JSDoc / line comments attached to the node.
  const fullStart = node.getStart(true);
  const end = node.getEnd();

  const startLine = sf.getLineAndColumnAtPos(fullStart).line;
  const endLine = sf.getLineAndColumnAtPos(end).line;

  const code = source.slice(fullStart, end);

  return {
    name: symbolName,
    kind: nodeKindLabel(node),
    startLine,
    endLine,
    code,
  };
}

export function listSymbols(absolutePath: string, source: string): SymbolListEntry[] {
  const sf = makeSourceFile(absolutePath, source);
  const entries: SymbolListEntry[] = [];

  for (const stmt of sf.getStatements()) {
    const exported = "isExported" in stmt && typeof (stmt as { isExported?: () => boolean }).isExported === "function"
      ? (stmt as { isExported: () => boolean }).isExported()
      : false;
    const start = stmt.getStart(true);
    const startLine = sf.getLineAndColumnAtPos(start).line;
    const endLine = sf.getLineAndColumnAtPos(stmt.getEnd()).line;
    const kind = nodeKindLabel(stmt);

    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement);
      const isExp = vs.isExported();
      for (const decl of vs.getDeclarations()) {
        entries.push({
          name: decl.getName(),
          kind: "VariableDeclaration",
          startLine,
          endLine,
          exported: isExp,
        });
      }
      continue;
    }

    const name = nodeName(stmt);
    if (name) {
      entries.push({ name, kind, startLine, endLine, exported });
    }
  }

  return entries;
}

export class SymbolNotFoundError extends Error {}

export interface EnclosingSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

// Walk the AST and find the deepest named function/class/method/variable
// whose source range contains the given line. Used to repair report manifests
// that stored only the top-level export symbol when the entry actually
// describes an inner helper (e.g. `handleDelete` inside `ProfilesPage`).
export function findEnclosingSymbol(
  absolutePath: string,
  source: string,
  line: number,
): EnclosingSymbol | null {
  const sf = makeSourceFile(absolutePath, source);
  // Probe at end-of-line so a target line that is the declaration line itself
  // (e.g. `async function handleDelete(...) {` at line 74) still resolves to
  // that function rather than to its parent.
  const safeLine = Math.max(1, line);
  const lineStarts = sf.compilerNode.getLineStarts();
  const lineStart = lineStarts[safeLine - 1] ?? 0;
  const nextLineStart = lineStarts[safeLine] ?? source.length;
  // Position just before the trailing newline of the target line.
  const targetPos = Math.max(lineStart, nextLineStart - 1);

  let best: { node: Node; depth: number; startLine: number } | null = null;

  function isNamedSymbolKind(kind: SyntaxKind): boolean {
    return (
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.MethodDeclaration ||
      kind === SyntaxKind.ClassDeclaration ||
      kind === SyntaxKind.InterfaceDeclaration ||
      kind === SyntaxKind.TypeAliasDeclaration ||
      kind === SyntaxKind.EnumDeclaration ||
      kind === SyntaxKind.VariableDeclaration
    );
  }

  function walk(node: Node, depth: number): void {
    const start = node.getStart(false); // ignore leading trivia for containment
    const end = node.getEnd();
    if (targetPos < start || targetPos > end) return;

    if (isNamedSymbolKind(node.getKind())) {
      const name = nodeName(node);
      if (name) {
        const sLine = sf.getLineAndColumnAtPos(start).line;
        // Prefer the deepest containing node, breaking ties on the highest startLine.
        if (
          !best ||
          depth > best.depth ||
          (depth === best.depth && sLine > best.startLine)
        ) {
          best = { node, depth, startLine: sLine };
        }
      }
    }

    node.forEachChild((child) => walk(child, depth + 1));
  }

  sf.forEachChild((child) => walk(child, 0));

  if (!best) return null;
  const node = (best as { node: Node }).node;
  const startLine = sf.getLineAndColumnAtPos(node.getStart(false)).line;
  const endLine = sf.getLineAndColumnAtPos(node.getEnd()).line;
  return {
    name: nodeName(node) || "",
    kind: nodeKindLabel(node),
    startLine,
    endLine,
  };
}

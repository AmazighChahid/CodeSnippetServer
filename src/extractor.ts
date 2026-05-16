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

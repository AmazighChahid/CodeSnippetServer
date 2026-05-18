import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config.js";
import { PathError, resolveSourcePath } from "./path-resolver.js";
import {
  extractSymbol,
  findEnclosingSymbol,
  listSymbols,
  SymbolNotFoundError,
  type ExtractedSymbol,
  type SymbolListEntry,
} from "./extractor.js";
import { extractAnchors, stripAnchorTags, narrowToAnchors, type AnchorRange } from "./anchors.js";
import { MtimeCache } from "./cache.js";
import { highlight, languageFor } from "./highlighter.js";

const config = loadConfig(process.env.CODE_SNIPPET_CONFIG);

const symbolCache = new MtimeCache<Map<string, ExtractedSymbol>>();
const listCache = new MtimeCache<SymbolListEntry[]>();
const highlightCache = new MtimeCache<Map<string, string>>();
const anchorCache = new MtimeCache<Map<string, AnchorRange[]>>();

const fastify = Fastify({ logger: { level: "info" } });

await fastify.register(cors, {
  origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
});

interface SnippetQuery {
  repo: string;
  file: string;
  symbol: string;
  format?: "json" | "html" | "text";
}

interface ListQuery {
  repo: string;
  file: string;
}

fastify.get("/health", async () => ({
  ok: true,
  repos: Object.keys(config.repos),
}));

fastify.get("/repos", async () => ({
  repos: Object.entries(config.repos).map(([name, r]) => ({
    name,
    description: r.description,
  })),
}));

interface FileQuery {
  repo: string;
  file: string;
}

// Serves any JSON file from a whitelisted repo. Used by report HTMLs to
// load their .anchors.json companion without hitting file:// CORS issues.
fastify.get<{ Querystring: FileQuery }>("/file", async (req, reply) => {
  const { repo, file } = req.query;
  if (!repo || !file) {
    return reply.code(400).send({ error: "repo and file are required" });
  }
  try {
    const absolute = resolveSourcePath(config, repo, file);
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(absolute, "utf8");
    if (file.endsWith(".json")) {
      reply.type("application/json; charset=utf-8");
    } else if (file.endsWith(".js") || file.endsWith(".mjs")) {
      reply.type("application/javascript; charset=utf-8");
    } else if (file.endsWith(".css")) {
      reply.type("text/css; charset=utf-8");
    } else if (file.endsWith(".md")) {
      reply.type("text/markdown; charset=utf-8");
    } else if (file.endsWith(".html")) {
      reply.type("text/html; charset=utf-8");
    } else {
      reply.type("text/plain; charset=utf-8");
    }
    return content;
  } catch (err) {
    return handleError(reply, err);
  }
});

fastify.get<{ Querystring: SnippetQuery }>("/snippet", async (req, reply) => {
  const { repo, file, symbol, format = "json" } = req.query;
  if (!repo || !file || !symbol) {
    return reply.code(400).send({ error: "repo, file and symbol are required" });
  }

  try {
    const absolute = resolveSourcePath(config, repo, file);

    const { source, cached } = symbolCache.get(absolute);
    let bySymbol = cached ?? new Map<string, ExtractedSymbol>();
    let extracted = bySymbol.get(symbol);

    if (!extracted) {
      extracted = extractSymbol(absolute, source, symbol);
      bySymbol.set(symbol, extracted);
      symbolCache.set(absolute, bySymbol);
    }

    // When anchors are present, narrow the displayed code to the smallest
    // window covering all anchors. If the symbol has no anchors, the full
    // function body is returned.
    const rawAnchors = extractAnchors(absolute, source, symbol);
    const { code: viewCode, anchors: viewAnchors, narrowed } =
      narrowToAnchors(extracted.code, rawAnchors);

    if (format === "text") {
      reply.type("text/plain; charset=utf-8");
      return viewCode;
    }

    if (format === "html") {
      const { cached: cachedHl } = highlightCache.get(absolute);
      const hlMap = cachedHl ?? new Map<string, string>();
      let html = hlMap.get(symbol);
      if (!html) {
        const { cleaned, cleanedLineAnchors } = stripAnchorTags(viewCode, viewAnchors);
        const rawHtml = await highlight(cleaned, languageFor(absolute), config.highlightTheme);
        html = injectLineAnchors(rawHtml, cleanedLineAnchors);
        hlMap.set(symbol, html);
        highlightCache.set(absolute, hlMap);
      }
      reply.type("text/html; charset=utf-8");
      return html;
    }

    return {
      repo,
      file,
      symbol: extracted.name,
      kind: extracted.kind,
      startLine: extracted.startLine,
      endLine: extracted.endLine,
      narrowed,
      code: viewCode,
    };
  } catch (err) {
    return handleError(reply, err);
  }
});

interface AnchorsQuery {
  repo: string;
  file: string;
  symbol: string;
}

fastify.get<{ Querystring: AnchorsQuery }>("/anchors", async (req, reply) => {
  const { repo, file, symbol } = req.query;
  if (!repo || !file || !symbol) {
    return reply.code(400).send({ error: "repo, file and symbol are required" });
  }
  try {
    const absolute = resolveSourcePath(config, repo, file);
    const { source, cached } = anchorCache.get(absolute);
    let bySymbol = cached ?? new Map<string, AnchorRange[]>();
    let anchors = bySymbol.get(symbol);
    if (!anchors) {
      anchors = extractAnchors(absolute, source, symbol);
      bySymbol.set(symbol, anchors);
      anchorCache.set(absolute, bySymbol);
    }
    return { repo, file, symbol, anchors };
  } catch (err) {
    return handleError(reply, err);
  }
});

fastify.get<{ Querystring: ListQuery }>("/list", async (req, reply) => {
  const { repo, file } = req.query;
  if (!repo || !file) {
    return reply.code(400).send({ error: "repo and file are required" });
  }

  try {
    const absolute = resolveSourcePath(config, repo, file);
    const { source, cached } = listCache.get(absolute);
    let symbols = cached;
    if (!symbols) {
      symbols = listSymbols(absolute, source);
      listCache.set(absolute, symbols);
    }
    return { repo, file, symbols };
  } catch (err) {
    return handleError(reply, err);
  }
});

interface SymbolAtLineQuery {
  repo: string;
  file: string;
  line: string;
}

// Return the deepest named symbol whose body contains the given line. Used by
// the VCExperience reports to repair manifests where `symbol` was stored as
// the top-level export when the entry actually documents an inner helper.
fastify.get<{ Querystring: SymbolAtLineQuery }>("/symbol-at-line", async (req, reply) => {
  const { repo, file, line } = req.query;
  if (!repo || !file || !line) {
    return reply.code(400).send({ error: "repo, file and line are required" });
  }
  const lineNum = Number(line);
  if (!Number.isFinite(lineNum) || lineNum < 1) {
    return reply.code(400).send({ error: "line must be a positive integer" });
  }
  try {
    const absolute = resolveSourcePath(config, repo, file);
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(absolute, "utf8");
    const sym = findEnclosingSymbol(absolute, source, lineNum);
    if (!sym) {
      return reply.code(404).send({ error: `no symbol found enclosing line ${lineNum}` });
    }
    return { repo, file, line: lineNum, symbol: sym };
  } catch (err) {
    return handleError(reply, err);
  }
});

/**
 * Decorate each <span class="line"> emitted by Shiki with a `data-anchors`
 * attribute listing anchor names that contain that line. The matching is
 * positional: the Nth `<span class="line">` corresponds to the Nth entry of
 * `lineAnchors` (which was built from the same cleaned code).
 */
function injectLineAnchors(html: string, lineAnchors: string[][]): string {
  let i = 0;
  return html.replace(/<span class="line">/g, () => {
    const names = lineAnchors[i] ?? [];
    i++;
    if (names.length === 0) return `<span class="line">`;
    return `<span class="line" data-anchors="${names.join(" ")}">`;
  });
}

function handleError(reply: FastifyReply, err: unknown) {
  if (err instanceof PathError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof SymbolNotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  fastify.log.error(err);
  const message = err instanceof Error ? err.message : "internal error";
  return reply.code(500).send({ error: message });
}

const address = await fastify.listen({ port: config.port, host: config.host });
fastify.log.info(`code-snippet-server listening on ${address}`);

import { resolve, relative, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { ServerConfig } from "./config.js";

export class PathError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function resolveSourcePath(
  config: ServerConfig,
  repoName: string,
  filePath: string,
): string {
  const repo = config.repos[repoName];
  if (!repo) {
    throw new PathError(`Unknown repo "${repoName}"`, 404);
  }

  if (isAbsolute(filePath)) {
    throw new PathError("file must be relative to the repo root", 400);
  }

  const absolute = resolve(repo.root, filePath);
  const rel = relative(repo.root, absolute);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathError("path traversal denied", 403);
  }

  if (!existsSync(absolute)) {
    throw new PathError(`file not found: ${rel}`, 404);
  }

  const stat = statSync(absolute);
  if (!stat.isFile()) {
    throw new PathError(`not a file: ${rel}`, 400);
  }

  return absolute;
}

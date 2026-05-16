import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

export interface RepoConfig {
  root: string;
  description?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  highlightTheme: string;
  repos: Record<string, RepoConfig>;
}

const DEFAULTS: Omit<ServerConfig, "repos"> = {
  port: 4477,
  host: "127.0.0.1",
  corsOrigins: ["*"],
  highlightTheme: "github-light",
};

export function loadConfig(configPath?: string): ServerConfig {
  const path = configPath ?? resolve(process.cwd(), "config.json");

  if (!existsSync(path)) {
    throw new Error(
      `Config file not found at ${path}. Copy config.example.json to config.json.`,
    );
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerConfig>;

  if (!raw.repos || Object.keys(raw.repos).length === 0) {
    throw new Error("config.repos must declare at least one repo");
  }

  for (const [name, repo] of Object.entries(raw.repos)) {
    if (!isAbsolute(repo.root)) {
      throw new Error(`Repo "${name}" root must be an absolute path: ${repo.root}`);
    }
    if (!existsSync(repo.root)) {
      throw new Error(`Repo "${name}" root does not exist: ${repo.root}`);
    }
  }

  return { ...DEFAULTS, ...raw, repos: raw.repos };
}

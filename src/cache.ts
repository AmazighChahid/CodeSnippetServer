import { statSync, readFileSync } from "node:fs";

interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

export class MtimeCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private readonly maxEntries = 200) {}

  get(absolutePath: string): { source: string; cached: T | undefined } {
    const stat = statSync(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    const entry = this.store.get(absolutePath);
    const fresh = entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
    return { source, cached: fresh ? entry!.value : undefined };
  }

  set(absolutePath: string, value: T): void {
    const stat = statSync(absolutePath);
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  }

  clear(): void {
    this.store.clear();
  }
}

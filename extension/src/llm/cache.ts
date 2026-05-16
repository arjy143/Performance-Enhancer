import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CacheKey } from './types';

const MAX_ENTRIES = 1000;

interface CacheEntry {
  value: string;
  writtenAt: number;
}

type CacheStore = Record<string, CacheEntry>;

export class LLMCache {
  private readonly _map = new Map<string, string>();
  private readonly _filePath: string;
  private _dirty = false;

  constructor(storageDir: string) {
    this._filePath = path.join(storageDir, 'llm-cache.json');
    this._load();
  }

  get(key: CacheKey): string | undefined {
    return this._map.get(this._hash(key));
  }

  set(key: CacheKey, value: string): void {
    const h = this._hash(key);
    if (this._map.has(h)) {
      this._map.delete(h);  // re-insert at end for LRU ordering
    }
    this._map.set(h, value);
    this._dirty = true;
    this._evict();
  }

  async persist(): Promise<void> {
    if (!this._dirty) return;
    const store: CacheStore = {};
    const now = Date.now();
    for (const [k, v] of this._map) {
      store[k] = { value: v, writtenAt: now };
    }
    try {
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(store), 'utf8');
      this._dirty = false;
    } catch {
      // Non-fatal — cache is still in memory.
    }
  }

  clear(): void {
    this._map.clear();
    this._dirty = true;
  }

  private _hash(key: CacheKey): string {
    return crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex');
  }

  private _evict(): void {
    while (this._map.size > MAX_ENTRIES) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
  }

  private _load(): void {
    try {
      if (!fs.existsSync(this._filePath)) return;
      const raw = fs.readFileSync(this._filePath, 'utf8');
      const store = JSON.parse(raw) as CacheStore;
      const sorted = Object.entries(store).sort(
        ([, a], [, b]) => a.writtenAt - b.writtenAt,
      );
      for (const [k, entry] of sorted) {
        this._map.set(k, entry.value);
      }
      this._evict();
    } catch {
      // Corrupt cache file — start fresh.
    }
  }
}

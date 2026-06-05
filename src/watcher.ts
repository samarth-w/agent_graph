/**
 * File watcher — auto-syncs the graph when source files change.
 *
 * Uses Node's native fs.watch with debouncing. Changes are batched
 * into a 2-second quiet window before triggering incremental re-index.
 */
import fs from 'fs';
import path from 'path';
import { indexProject } from './indexer';
import { DEFAULT_CONFIG, detectLanguage } from './config';

export interface WatcherOptions {
  debounceMs?: number;
  onSync?: (result: { files_changed: number; duration_ms: number }) => void;
  onError?: (err: Error) => void;
}

export class FileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private changedFiles = new Set<string>();
  private syncing = false;
  private stopped = false;
  private debounceMs: number;
  private onSync: WatcherOptions['onSync'];
  private onError: WatcherOptions['onError'];

  constructor(
    private rootDir: string,
    opts: WatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.onSync = opts.onSync;
    this.onError = opts.onError;
  }

  start(): void {
    this.stopped = false;

    // Watch the root directory recursively (Node 19+, macOS/Linux/Windows)
    try {
      const watcher = fs.watch(this.rootDir, { recursive: true }, (eventType, filename) => {
        if (!filename || this.stopped) return;
        this.handleChange(filename);
      });

      watcher.on('error', (err) => {
        // Recursive watch not supported — fall back to watching known dirs
        if ((err as any).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
          this.watchDirectoriesManually();
        } else {
          this.onError?.(err);
        }
      });

      this.watchers.push(watcher);
    } catch {
      // Fallback for platforms without recursive watch
      this.watchDirectoriesManually();
    }
  }

  private watchDirectoriesManually(): void {
    // Collect unique directories from config extensions
    const dirs = new Set<string>();
    dirs.add(this.rootDir);

    const walkSync = (dir: string, depth = 0) => {
      if (depth > 5) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            if (DEFAULT_CONFIG.ignorePaths.includes(entry.name)) continue;
            dirs.add(fullPath);
            walkSync(fullPath, depth + 1);
          }
        }
      } catch {
        // skip unreadable
      }
    };
    walkSync(this.rootDir);

    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (!filename || this.stopped) return;
          const rel = path.relative(this.rootDir, path.join(dir, filename));
          this.handleChange(rel);
        });
        this.watchers.push(watcher);
      } catch {
        // skip unwatchable
      }
    }
  }

  private handleChange(filename: string): void {
    const normalized = filename.replace(/\\/g, '/');

    // Skip non-source files
    if (!detectLanguage(normalized)) return;

    // Skip ignored paths
    for (const ignore of DEFAULT_CONFIG.ignorePaths) {
      if (normalized.includes(ignore + '/') || normalized.startsWith(ignore)) return;
    }

    this.changedFiles.add(normalized);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.runSync();
      // Re-arm if more changes accumulated during the sync
      if (!this.stopped && this.changedFiles.size > 0 && !this.timer) {
        this.scheduleSync();
      }
    }, this.debounceMs);
  }

  private async runSync(): Promise<void> {
    if (this.syncing || this.stopped || this.changedFiles.size === 0) return;
    this.syncing = true;
    this.changedFiles.clear();

    try {
      const result = await indexProject(this.rootDir, { force: false });
      this.onSync?.({
        files_changed: result.files_changed,
        duration_ms: result.duration_ms,
      });
    } catch (err: any) {
      this.onError?.(err);
    } finally {
      this.syncing = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const w of this.watchers) {
      try { w.close(); } catch {}
    }
    this.watchers = [];
    this.changedFiles.clear();
  }
}

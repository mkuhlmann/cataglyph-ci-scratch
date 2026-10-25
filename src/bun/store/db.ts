// Persistence, split by how disposable the data is (directories per platform in dirs.ts):
//
//   <cache>/cache.db    analyses + basics, keyed by content key. Losing it only costs a
//                       re-analysis.
//   <cache>/thumbs/     thumbnail/preview files (media/thumbs.ts)
//   <cache>/video/      720p AV1 video proxies (media/video.ts)
//   <cache>/chromium/   Electron's browser profile (src/electron/main.ts)
//   <data>/state.db     the user's decisions per folder. Losing these loses work, so not in a
//                       cache dir.
//   <config>/settings.json   settings
//
// Nothing is written into the photo folder itself: it is about to become an archive album,
// and app droppings in it would be archived along with the photos.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_SETTINGS, type AnalysisSummary, type Decision, type Settings } from "../../shared/types.ts";
import { CACHE_DIR, CONFIG_DIR, DATA_DIR, XDG_CACHE, XDG_CONFIG, XDG_DATA } from "./dirs.ts";

export { CACHE_DIR, CONFIG_DIR, DATA_DIR };

// Earlier builds used ~/.cache/cataglyph, ~/.local/share/cataglyph and ~/.config/cataglyph.
// Each is renamed into place once, as a whole, so state.db moves together with its -wal
// file (moved apart, SQLite would lose the decisions still in the WAL).
//
// The cache is the exception: the Electrobun builds' CEF created CACHE_DIR before this ran,
// so its entries move one by one. That is only cache, and whatever fails to move is rebuilt.
// Those builds were Linux-only, so there is nothing to adopt on macOS or Windows.
function adoptLegacyDirs() {
    if (process.platform !== "linux") return;
    for (const [root, target] of [[XDG_DATA, DATA_DIR], [XDG_CONFIG, CONFIG_DIR]] as const) {
        const legacy = join(root, "cataglyph");
        if (!existsSync(legacy) || existsSync(target)) continue;
        try {
            renameSync(legacy, target);
        } catch (err) {
            console.warn(`[store] could not move ${legacy} to ${target}: ${(err as Error).message}`);
        }
    }
    const legacyCache = join(XDG_CACHE, "cataglyph");
    if (!existsSync(legacyCache)) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    for (const name of readdirSync(legacyCache)) {
        const target = join(CACHE_DIR, name);
        if (existsSync(target)) continue;
        try {
            renameSync(join(legacyCache, name), target);
        } catch {
            // Left behind; the cache rebuilds what is missing.
        }
    }
    try {
        rmdirSync(legacyCache);
    } catch {
        // Not empty (a name already existed in the new place): leave it for the user.
    }
}
adoptLegacyDirs();

function open(path: string): Database {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    return db;
}

export class Store {
    private cache: Database;
    private state: Database;

    constructor(private cachePath = join(CACHE_DIR, "cache.db"), statePath = join(DATA_DIR, "state.db")) {
        this.cache = open(cachePath);
        this.state = open(statePath);
        this.cache.exec(`
            CREATE TABLE IF NOT EXISTS analyses (
                content_key TEXT NOT NULL,
                model TEXT NOT NULL,
                summary TEXT NOT NULL,
                json TEXT NOT NULL,
                PRIMARY KEY (content_key, model)
            );
            CREATE TABLE IF NOT EXISTS basics (
                content_key TEXT PRIMARY KEY,
                capture_time REAL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL
            );
        `);
        this.state.exec(`
            CREATE TABLE IF NOT EXISTS decisions (
                folder TEXT NOT NULL,
                item_id TEXT NOT NULL,
                verdict TEXT NOT NULL,
                source TEXT NOT NULL,
                keep_raw INTEGER NOT NULL,
                PRIMARY KEY (folder, item_id)
            );
        `);
    }

    // Content keys embed the folder-relative path, so the same photo opened from two folders
    // is analysed twice. That is rare enough not to warrant hashing file contents.
    getAnalysis(contentKey: string, model: string): { summary: AnalysisSummary; json: string } | null {
        const row = this.cache
            .query<{ summary: string; json: string }, [string, string]>("SELECT summary, json FROM analyses WHERE content_key = ? AND model = ?")
            .get(contentKey, model);
        return row ? { summary: JSON.parse(row.summary) as AnalysisSummary, json: row.json } : null;
    }

    putAnalysis(contentKey: string, model: string, summary: AnalysisSummary, json: string) {
        this.cache
            .query("INSERT OR REPLACE INTO analyses (content_key, model, summary, json) VALUES (?, ?, ?, ?)")
            .run(contentKey, model, JSON.stringify(summary), json);
    }

    getBasics(contentKey: string): { captureTime: number | null; width: number; height: number } | null {
        const row = this.cache
            .query<{ capture_time: number | null; width: number; height: number }, [string]>("SELECT capture_time, width, height FROM basics WHERE content_key = ?")
            .get(contentKey);
        return row ? { captureTime: row.capture_time, width: row.width, height: row.height } : null;
    }

    putBasics(contentKey: string, b: { captureTime: number | null; width: number; height: number }) {
        this.cache
            .query("INSERT OR REPLACE INTO basics (content_key, capture_time, width, height) VALUES (?, ?, ?, ?)")
            .run(contentKey, b.captureTime, b.width, b.height);
    }

    /** Cached analyses (all models) and the size of cache.db on disk, WAL included. */
    cacheUsage(): { bytes: number; count: number } {
        const row = this.cache.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM analyses").get();
        let bytes = 0;
        for (const suffix of ["", "-wal", "-shm"]) {
            try {
                bytes += statSync(this.cachePath + suffix).size;
            } catch {
                // No WAL right after a checkpoint.
            }
        }
        return { bytes, count: row?.n ?? 0 };
    }

    /**
     * Empties cache.db: analyses and basics. DELETE alone leaves the file at its size, so it
     * is vacuumed and the WAL truncated to give the space back.
     */
    clearCache() {
        this.cache.exec("DELETE FROM analyses; DELETE FROM basics;");
        this.cache.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    }

    getDecisions(folder: string): Record<string, Decision> {
        const rows = this.state
            .query<{ item_id: string; verdict: string; source: string; keep_raw: number }, [string]>(
                "SELECT item_id, verdict, source, keep_raw FROM decisions WHERE folder = ?",
            )
            .all(folder);
        const out: Record<string, Decision> = {};
        for (const r of rows) {
            out[r.item_id] = {
                verdict: r.verdict === "delete" ? "delete" : "keep",
                source: r.source === "manual" ? "manual" : "auto",
                keepRaw: r.keep_raw === 1,
            };
        }
        return out;
    }

    putDecisions(folder: string, decisions: Record<string, Decision>) {
        const stmt = this.state.query(
            "INSERT OR REPLACE INTO decisions (folder, item_id, verdict, source, keep_raw) VALUES (?, ?, ?, ?, ?)",
        );
        this.state.transaction(() => {
            for (const [id, d] of Object.entries(decisions)) stmt.run(folder, id, d.verdict, d.source, d.keepRaw ? 1 : 0);
        })();
    }

    /** Drops decisions for items that no longer exist (deleted or converted). */
    pruneDecisions(folder: string, keepIds: Iterable<string>) {
        const keep = new Set(keepIds);
        const ids = Object.keys(this.getDecisions(folder)).filter(id => !keep.has(id));
        const stmt = this.state.query("DELETE FROM decisions WHERE folder = ? AND item_id = ?");
        this.state.transaction(() => { for (const id of ids) stmt.run(folder, id); })();
    }

    close() {
        this.cache.close();
        this.state.close();
    }
}

const SETTINGS_PATH = join(CONFIG_DIR, "settings.json");

// Merged over the defaults field by field, so a settings file from an older version that
// lacks a newer key still loads.
export async function loadSettings(): Promise<Settings> {
    try {
        const saved = await Bun.file(SETTINGS_PATH).json() as Partial<Settings>;
        return {
            ...DEFAULT_SETTINGS,
            ...saved,
            thresholds: { ...DEFAULT_SETTINGS.thresholds, ...saved.thresholds },
            convert: { ...DEFAULT_SETTINGS.convert, ...saved.convert },
        };
    } catch {
        return structuredClone(DEFAULT_SETTINGS);
    }
}

export async function saveSettings(settings: Settings) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 4));
}

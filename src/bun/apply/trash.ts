import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface TrashResult {
    path: string;
    ok: boolean;
    error?: string;
}

export interface TrashOptions {
    /**
     * "auto" picks the host (macOS, Windows), else gio, then kioclient, then the built-in spec
     * implementation.
     */
    backend?: "auto" | "host" | "gio" | "kioclient" | "spec";
    /** Trash directory for the spec backend (tests pass a temp dir). Default: $XDG_DATA_HOME/Trash. */
    trashDir?: string;
    batchSize?: number;
}

const DEFAULT_BATCH = 100;

type HostTrash = (paths: string[]) => Promise<TrashResult[]>;
let hostTrash: HostTrash | null = null;

/**
 * Hands trashing to the Electron main process (shell.trashItem). On macOS that is the only
 * proper way in: the Finder's trash has no file layout to write into like the freedesktop
 * one, and NSFileManager's trashItemAtURL (what shell.trashItem calls) is what makes "Put
 * Back" work. Windows likewise: shell.trashItem goes through IFileOperation into the Recycle
 * Bin, whose per-volume $Recycle.Bin layout is not meant to be written by hand.
 */
export function setHostTrash(fn: HostTrash) {
    hostTrash = fn;
}

/**
 * Move files to the system trash so they can be restored: the freedesktop trash on Linux
 * (shows up in Dolphin's trash:/), the Finder's on macOS, the Recycle Bin on Windows. Every path gets its own result:
 * one bad file must not hide the others.
 */
export async function moveToTrash(paths: string[], opts: TrashOptions = {}): Promise<TrashResult[]> {
    if (paths.length === 0) return [];
    const backend = opts.backend && opts.backend !== "auto" ? opts.backend : pickBackend();
    const size = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
    const results: TrashResult[] = [];

    if (backend === "host") {
        if (!hostTrash) throw new Error("no host trash registered");
        for (let i = 0; i < paths.length; i += size) results.push(...await hostTrash(paths.slice(i, i + size)));
        return results;
    }

    if (backend === "spec") {
        for (const path of paths) results.push(await trashWithSpec(path, opts.trashDir ?? defaultTrashDir()));
        return results;
    }

    for (let i = 0; i < paths.length; i += size) {
        const batch = paths.slice(i, i + size);
        const first = await runTool(backend, batch);
        if (first.ok) {
            for (const path of batch) results.push({ path, ok: true });
            continue;
        }
        // gio/kioclient exit non-zero if ANY file failed and don't say which ones, so retry
        // one by one. Files that already made it to the trash are gone from their place and
        // would now report "not found", so a retry only runs for those still on disk.
        for (const path of batch) {
            if (!(await exists(path))) {
                results.push({ path, ok: true });
                continue;
            }
            const single = await runTool(backend, [path]);
            results.push(single.ok ? { path, ok: true } : { path, ok: false, error: single.error });
        }
    }
    return results;
}

function pickBackend(): "host" | "gio" | "kioclient" | "spec" {
    if (hostTrash) return "host";
    if (Bun.which("gio")) return "gio";
    if (Bun.which("kioclient")) return "kioclient";
    if (Bun.which("kioclient5")) return "kioclient";
    return "spec";
}

async function runTool(backend: "gio" | "kioclient", paths: string[]): Promise<{ ok: boolean; error?: string }> {
    let cmd: string[];
    if (backend === "gio") {
        // "--" so a file named "-foo.jpg" is not parsed as an option.
        cmd = ["gio", "trash", "--", ...paths];
    } else {
        const bin = Bun.which("kioclient") ? "kioclient" : "kioclient5";
        cmd = [bin, "move", ...paths, "trash:/"];
    }
    try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        await new Response(proc.stdout).text();
        if (code === 0) return { ok: true };
        return { ok: false, error: stderr.trim() || `${cmd[0]} exited ${code}` };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function defaultTrashDir(): string {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(dataHome, "Trash");
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

/** Local time, no zone, as the spec requires: YYYY-MM-DDThh:mm:ss. */
function deletionDate(d = new Date()): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Percent-encode each path segment but keep the slashes (spec: URL-encoded Path). */
function encodePath(path: string): string {
    return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Freedesktop Trash spec, home trash only. Rename is the only transport: across filesystems
 * we report an error rather than copying, because a copy of a big photo folder into $HOME
 * is not what "move to trash" promises and would not be atomic.
 */
async function trashWithSpec(path: string, trashDir: string): Promise<TrashResult> {
    try {
        const filesDir = join(trashDir, "files");
        const infoDir = join(trashDir, "info");
        await mkdir(filesDir, { recursive: true, mode: 0o700 });
        await mkdir(infoDir, { recursive: true, mode: 0o700 });

        const [source, trash] = await Promise.all([stat(path), stat(trashDir)]);
        if (source.dev !== trash.dev) {
            return { path, ok: false, error: "file is on a different filesystem than the trash" };
        }

        const absolute = path.startsWith("/") ? path : join(process.cwd(), path);
        const base = basename(path);
        const content = `[Trash Info]\nPath=${encodePath(absolute)}\nDeletionDate=${deletionDate()}\n`;

        // Claim the name by creating the .trashinfo exclusively (wx) first, as the spec
        // recommends, so two concurrent trashers can't pick the same name.
        for (let n = 1; n < 10000; n++) {
            const name = n === 1 ? base : `${base}.${n}`;
            const infoPath = join(infoDir, `${name}.trashinfo`);
            let handle;
            try {
                handle = await open(infoPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
                throw error;
            }
            try {
                await handle.writeFile(content);
            } finally {
                await handle.close();
            }
            const target = join(filesDir, name);
            if (await exists(target)) {
                // Orphaned file without an info entry: don't overwrite it, try the next name.
                await unlink(infoPath).catch(() => {});
                continue;
            }
            try {
                await rename(path, target);
            } catch (error) {
                await unlink(infoPath).catch(() => {});
                throw error;
            }
            return { path, ok: true };
        }
        return { path, ok: false, error: "no free name in trash" };
    } catch (error) {
        return { path, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

// Groups the loose files of one folder into Items ("shots"). Pure: no fs access, so every
// camera naming scheme can be covered by in-memory fixtures (see test/pairing.test.ts).

import type { Item, MediaFile } from "../../shared/types.ts";

export const STILL_EXTS = new Set(["jpg", "jpeg", "heic", "heif", "png"]);
/** Already archived stills: shown and classified, never converted again. */
export const ARCHIVE_EXTS = new Set(["jxl"]);
export const RAW_EXTS = new Set(["arw", "dng", "cr2", "cr3", "nef", "raf", "orf", "rw2", "pef", "srw"]);
export const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "3gp", "mkv"]);
export const SIDECAR_EXTS = new Set(["pp3", "xmp", "dop"]);

export interface PairingResult {
    items: Item[];
    ignored: MediaFile[];
    /** Videos sharing a still's key: scan.ts verifies them and merges them into `motion`. */
    liveCandidates: { itemId: string; video: MediaFile }[];
}

// The suffixes conversion tools append to their outputs (this app's cjxl step, and the mozjpeg
// "_moz_q85" of media-batch). A still with such a name is someone's output, not a new photo:
// a re-encoded JPG would be converted a second time. A .jxl with it is the archived version of
// a shot and is shown as such, and a video with it is the motion half that step 5 wrote next
// to its .jxl (DSC1_lossy_d1.0.mp4). For both, the suffix is stripped from the pairing key, so
// DSC1_lossy_d1.0.jxl still pairs with a DSC1.ARW and its pp3 left in the folder.
const GENERATED_STEM = /_(lossy(_d\d+(\.\d+)?)?|lossless|moz_q\d+)$/i;

// Lower number wins the primary slot.
const STILL_PRIORITY: Record<string, number> = { jpg: 0, jpeg: 0, heic: 1, heif: 1, png: 2 };

function stemOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

// Grouping key. Pixel writes RAW+JPEG as PXL_x.RAW-01.COVER.jpg (or .RAW-01.MP.COVER.jpg)
// beside PXL_x.RAW-02.ORIGINAL.dng, so everything from ".RAW-0N" on is dropped. A trailing
// ".MP" (Pixel motion photo, PXL_x.MP.jpg) is dropped too: the motion photo is still the
// same shot as PXL_x, and Pixel never pairs a DNG with it by plain name, so the only effect
// is that a stray PXL_x.jpg + PXL_x.MP.jpg are treated as two stills of one key and the
// second becomes its own item rather than being lost. A conversion suffix goes first, since
// cjxl appends it after the Pixel parts (PXL_x.RAW-01.MP.COVER_lossy_d1.0.jxl).
function keyOf(stem: string): string {
    return stem
        .replace(GENERATED_STEM, "")
        .toLowerCase()
        .replace(/\.raw-\d+(\..*)?$/, "")
        .replace(/\.mp$/, "");
}

/**
 * Cache key for thumbnails, basics and analyses. Exported so session.ts can carry an analysis
 * over to the .jxl a conversion just wrote, before the rescan builds its item.
 */
export function contentKeyOf(id: string, primary: Pick<MediaFile, "size" | "mtimeMs">): string {
    return `${id}:${primary.size}:${Math.round(primary.mtimeMs)}`;
}

function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

// Item ids are paths relative to the folder. Windows paths (from the folder dialog and
// path.join) use "\\", so either separator ends the folder prefix.
function relativeTo(folder: string, path: string): string {
    const base = folder.replace(/[\\/]$/, "");
    const sep = path[base.length];
    return path.startsWith(base) && (sep === "/" || sep === "\\") ? path.slice(base.length + 1) : path;
}

interface Group {
    stills: MediaFile[];
    archives: MediaFile[];
    raws: MediaFile[];
    videos: MediaFile[];
}

export function pairFiles(files: MediaFile[], folder: string): PairingResult {
    const ignored: MediaFile[] = [];
    const sidecars: MediaFile[] = [];
    const groups = new Map<string, Group>();

    for (const file of files) {
        const ext = file.ext.toLowerCase();
        const isMedia = STILL_EXTS.has(ext) || ARCHIVE_EXTS.has(ext) || RAW_EXTS.has(ext) || VIDEO_EXTS.has(ext);
        const generated = (STILL_EXTS.has(ext) || RAW_EXTS.has(ext)) && GENERATED_STEM.test(stemOf(file.name));
        if (file.name.startsWith(".") || generated) {
            ignored.push(file);
            continue;
        }
        if (SIDECAR_EXTS.has(ext)) {
            sidecars.push(file);
            continue;
        }
        if (!isMedia) {
            ignored.push(file);
            continue;
        }
        const key = keyOf(stemOf(file.name));
        let group = groups.get(key);
        if (!group) {
            group = { stills: [], archives: [], raws: [], videos: [] };
            groups.set(key, group);
        }
        if (STILL_EXTS.has(ext)) group.stills.push(file);
        else if (ARCHIVE_EXTS.has(ext)) group.archives.push(file);
        else if (RAW_EXTS.has(ext)) group.raws.push(file);
        else group.videos.push(file);
    }

    const makeItem = (kind: Item["kind"], primary: MediaFile, raw: MediaFile | null): Item => {
        const id = relativeTo(folder, primary.path);
        return {
            id,
            kind,
            primary,
            raw,
            primarySidecars: [],
            rawSidecars: [],
            originals: [],
            motion: null,
            embeddedMotion: false,
            hasGainMap: false,
            captureTime: null,
            width: 0,
            height: 0,
            contentKey: contentKeyOf(id, primary),
        };
    };

    const items: Item[] = [];
    const liveCandidates: PairingResult["liveCandidates"] = [];
    // Which item (and slot) a file name belongs to, for sidecar attachment.
    const byName = new Map<string, { item: Item; role: "primary" | "raw" }>();
    // Per key: where a "<stem>.xmp" sidecar goes.
    const byKey = new Map<string, { item: Item; role: "primary" | "raw" }>();

    for (const [key, group] of groups) {
        const stills = [...group.stills].sort(
            (a, b) => (STILL_PRIORITY[a.ext.toLowerCase()] ?? 9) - (STILL_PRIORITY[b.ext.toLowerCase()] ?? 9)
                || naturalCompare(a.name, b.name),
        );
        const raws = [...group.raws].sort((a, b) => naturalCompare(a.name, b.name));
        const firstRaw = raws[0] ?? null;
        const archives = [...group.archives].sort((a, b) => naturalCompare(a.name, b.name));
        const firstStill = stills[0] ?? null;
        const firstArchive = archives[0] ?? null;
        let keyed: Item | null = null;

        if (firstArchive) {
            // The archived version is the shot now. Stills it was made from that are still
            // around (originals kept in place, or a run that couldn't remove them) ride along:
            // shown as the same photo, deleted with it, never converted a second time.
            const main = makeItem("archived", firstArchive, firstRaw);
            main.originals = stills;
            items.push(main);
            byName.set(firstArchive.name.toLowerCase(), { item: main, role: "primary" });
            for (const still of stills) byName.set(still.name.toLowerCase(), { item: main, role: "primary" });
            if (firstRaw) byName.set(firstRaw.name.toLowerCase(), { item: main, role: "raw" });
            byKey.set(key, { item: main, role: firstRaw ? "raw" : "primary" });
            keyed = main;
            // Lossy and lossless of the same shot are two archives the user may want to choose
            // between, so each stays its own item.
            for (const extra of archives.slice(1)) {
                const item = makeItem("archived", extra, null);
                items.push(item);
                byName.set(extra.name.toLowerCase(), { item, role: "primary" });
            }
            for (const extra of raws.slice(1)) {
                const item = makeItem("raw-only", extra, null);
                items.push(item);
                byName.set(extra.name.toLowerCase(), { item, role: "primary" });
            }
        } else if (firstStill) {
            // Duplicate stills are separate items; a RAW only ever pairs with the best one.
            const main = makeItem("photo", firstStill, firstRaw);
            items.push(main);
            byName.set(firstStill.name.toLowerCase(), { item: main, role: "primary" });
            if (firstRaw) byName.set(firstRaw.name.toLowerCase(), { item: main, role: "raw" });
            byKey.set(key, { item: main, role: firstRaw ? "raw" : "primary" });
            keyed = main;
            for (const extra of stills.slice(1)) {
                const item = makeItem("photo", extra, null);
                items.push(item);
                byName.set(extra.name.toLowerCase(), { item, role: "primary" });
            }
            for (const extra of raws.slice(1)) {
                const item = makeItem("raw-only", extra, null);
                items.push(item);
                byName.set(extra.name.toLowerCase(), { item, role: "primary" });
            }
        } else {
            for (const [i, raw] of raws.entries()) {
                const item = makeItem("raw-only", raw, null);
                items.push(item);
                byName.set(raw.name.toLowerCase(), { item, role: "primary" });
                if (i === 0) {
                    byKey.set(key, { item, role: "primary" });
                    keyed = item;
                }
            }
        }

        for (const video of group.videos) {
            const item = makeItem("video", video, null);
            items.push(item);
            byName.set(video.name.toLowerCase(), { item, role: "primary" });
            if (!byKey.has(key)) byKey.set(key, { item, role: "primary" });
            // Only a still makes a video a live-photo candidate; verification happens in scan.ts.
            if ((firstStill || firstArchive) && keyed) liveCandidates.push({ itemId: keyed.id, video });
        }
    }

    for (const sidecar of sidecars) {
        // "<file name>.<sidecar ext>" names exactly one file; "<stem>.<sidecar ext>" is looser.
        const base = sidecar.name.slice(0, sidecar.name.length - sidecar.ext.length - 1);
        const target = byName.get(base.toLowerCase()) ?? byKey.get(keyOf(base));
        if (!target) {
            ignored.push(sidecar);
            continue;
        }
        (target.role === "raw" ? target.item.rawSidecars : target.item.primarySidecars).push(sidecar);
    }

    items.sort((a, b) => naturalCompare(a.primary.name, b.primary.name));
    return { items, ignored, liveCandidates };
}

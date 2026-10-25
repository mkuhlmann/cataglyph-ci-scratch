// The application behind the window: the view's requests and the long-lived services that
// answer them. The window itself belongs to the Electron main process (src/electron/main.ts),
// which relays the view's requests here and does what needs Electron on this process's
// behalf (host.ts).

import { homedir } from "node:os";

import type { CachePart, CacheUsage, Details, FileInfo } from "../shared/rpc.ts";
import type { Settings } from "../shared/types.ts";
import { setHostTrash } from "./apply/trash.ts";
import { EyeClient } from "./classify/eye-client.ts";
import { host, send, serve } from "./host.ts";
import { MediaServer } from "./media/server.ts";
import { THUMB_DIR } from "./media/thumbs.ts";
import { forgetProxies, playable, TranscodeDisabled, VIDEO_DIR } from "./media/video.ts";
import { readDetails, shutdownMetadata } from "./meta/metadata.ts";
import { Session } from "./session.ts";
import { clearDir, dirUsage } from "./store/cache.ts";
import { CACHE_DIR, loadSettings, saveSettings, Store } from "./store/db.ts";

// The UI language for "auto". The main process passes the desktop's preferred language
// (Electron's app.getPreferredSystemLanguages(), the only source on macOS, where an app
// started from the Finder has no LANG). The POSIX locale variables are the fallback for a run
// without it ("de_DE.UTF-8" -> "de").
function systemLocale(): string {
    if (process.env.CATAGLYPH_LOCALE) return process.env.CATAGLYPH_LOCALE;
    const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "en";
    return raw.split(/[._@]/)[0]!.replace("_", "-").toLowerCase();
}

let settings: Settings = await loadSettings();
const store = new Store();
const eye = new EyeClient();
const media = new MediaServer(() => settings.transcodeVideos);

if (process.platform !== "linux") setHostTrash(paths => host("trash", { paths }));

const session = new Session(store, eye, media, {
    eye: info => send("eye", info),
    analyses: batch => send("analyses", batch),
    judged: payload => send("judged", payload),
    items: items => send("items", items),
    applyProgress: p => send("applyProgress", p),
    convertProgress: p => send("convertProgress", p),
}, () => settings);

async function cacheUsage(): Promise<CacheUsage> {
    const [thumbs, video, browser] = await Promise.all([dirUsage(THUMB_DIR), dirUsage(VIDEO_DIR), host("browserCache", { clear: false })]);
    return { dir: CACHE_DIR, parts: { thumbs, video, analyses: store.cacheUsage(), browser: { bytes: browser, count: null } } };
}

async function clearCache(parts: CachePart[]): Promise<CacheUsage> {
    // A running analysis reads display sources from thumbs/ and writes into cache.db; pulling
    // a file from under Eye would fail that item.
    const state = session.eyeStatus().state;
    if ((parts.includes("thumbs") || parts.includes("analyses")) && (state === "running" || state === "starting")) {
        throw new Error("analysis is running");
    }
    if (parts.includes("thumbs")) await clearDir(THUMB_DIR);
    if (parts.includes("video")) {
        await clearDir(VIDEO_DIR);
        forgetProxies();
    }
    // The open folder keeps its analyses in memory; they are re-run when a folder is opened.
    if (parts.includes("analyses")) store.clearCache();
    if (parts.includes("browser")) await host("browserCache", { clear: true });
    return cacheUsage();
}

serve({
    init: () => ({ settings, mediaBase: media.baseUrl, mediaToken: media.token, home: homedir(), systemLocale: systemLocale() }),
    pickFolder: () => host("pickFolder", { start: settings.recentFolders[0] ?? homedir() }),
    openFolder: async ({ folder }) => {
        const state = await session.open(folder);
        settings = { ...settings, recentFolders: [folder, ...settings.recentFolders.filter(f => f !== folder)].slice(0, 8) };
        await saveSettings(settings);
        send("eye", session.eyeStatus());
        return state;
    },
    setDecisions: ({ changes }) => session.setDecisions(changes),
    resetDecisions: ({ ids }) => session.resetDecisions(ids),
    startAnalysis: () => session.startAnalysis(),
    stopAnalysis: () => session.stopAnalysis(),
    details: async ({ id }): Promise<Details> => {
        const item = session.item(id);
        if (!item) throw new Error(`unknown item ${id}`);
        const files: FileInfo[] = [
            { role: "image", name: item.primary.name, size: item.primary.size },
            ...item.originals.map(f => ({ role: "original" as const, name: f.name, size: f.size })),
            ...(item.raw ? [{ role: "raw" as const, name: item.raw.name, size: item.raw.size }] : []),
            ...[...item.primarySidecars, ...item.rawSidecars].map(f => ({ role: "sidecar" as const, name: f.name, size: f.size })),
            ...(item.motion ? [{ role: "motion" as const, name: item.motion.name, size: item.motion.size }] : []),
        ];
        try {
            return { ...await readDetails(item.primary.path), files };
        } catch (err) {
            return { rows: [["error", (err as Error).message]], gps: null, files };
        }
    },
    previewApply: ({ deleteMode }) => session.previewApply(deleteMode),
    runApply: ({ deleteMode }) => session.runApply(deleteMode),
    previewConvert: () => session.previewConvert(),
    runConvert: async ({ settings: convert }) => {
        settings = { ...settings, convert };
        await saveSettings(settings);
        return session.runConvert(convert);
    },
    cancelConvert: () => session.cancelConvert(),
    saveSettings: async ({ settings: next }) => {
        const thresholdsChanged = JSON.stringify(next.thresholds) !== JSON.stringify(settings.thresholds);
        settings = next;
        await saveSettings(settings);
        if (thresholdsChanged && session.folder) {
            session.rejudge();
            send("judged", { judgements: session.judgements, stacks: session.stacks, decisions: session.decisions });
        }
        return settings;
    },
    openExternal: ({ id, path }) => {
        const target = path ?? (id ? session.item(id)?.primary.path : undefined);
        return target ? host("openPath", { path: target }) : false;
    },
    cacheUsage: () => cacheUsage(),
    clearCache: ({ parts }) => clearCache(parts),
    // https only: the view is local, but nothing it sends should be able to launch file://
    // paths or custom URL schemes through this. The main process checks again.
    openUrl: ({ url }) => url.startsWith("https://") && host("openUrl", { url }),
    prepareVideo: async ({ id }) => {
        const item = session.item(id);
        if (item?.kind !== "video") return { ok: false, error: "not a video" };
        try {
            // ffmpeg reports progress several times a second; the view needs whole percents.
            let last = -1;
            await playable(item, settings.transcodeVideos, pct => {
                const rounded = Math.floor(pct);
                if (rounded !== last) send("videoProgress", { id, pct: (last = rounded) });
            });
            return { ok: true };
        } catch (err) {
            if (err instanceof TranscodeDisabled) return { ok: false, error: err.message, disabled: true };
            return { ok: false, error: (err as Error).message };
        }
    },
}, async () => {
    await eye.stop();
    await shutdownMetadata();
    media.stop();
    store.close();
});

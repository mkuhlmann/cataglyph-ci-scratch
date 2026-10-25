// The Electron main process: the window, the few things that need the native toolkit, and the
// relay between the view and the Bun process that does the actual work (sidecar.ts).
//
// It runs from build/app/ in a dev run and from resources/app/ in a packaged one; both hold
// the same layout (scripts/build.ts), and app.getAppPath() is that directory.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } from "electron";

import { CACHE_DIR } from "../bun/store/dirs.ts";
import { Sidecar } from "./sidecar.ts";

const APP_ROOT = app.getAppPath();
const DEV = !app.isPackaged;

// Chromium's JPEG XL decoder (jxl-rs) ships behind this feature flag; without it <img> can't
// show the archive format the app itself writes. The feature is called JXLImageFormat
// (`strings libcef.so` on the Chromium 147 that Electrobun bundled; "Jxl" is silently
// ignored).
app.commandLine.appendSwitch("enable-features", "JXLImageFormat");
// Dev runs can be driven over CDP (see CLAUDE.md, "Testing the running app").
if (DEV) app.commandLine.appendSwitch("remote-debugging-port", "9222");

// Chromium's profile goes into the app's own cache directory rather than Electron's default
// ~/.config/Cataglyph: it is only cache (the view keeps nothing in browser storage), and the
// app's data should stay under one name (store/dirs.ts).
app.setPath("userData", join(CACHE_DIR, "chromium"));

let win: BrowserWindow | null = null;

function sidecarEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const [language] = app.getPreferredSystemLanguages();
    if (language) env.CATAGLYPH_LOCALE = language;
    // An app started from the Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, without
    // Homebrew, where ffmpeg/ffprobe (video posters and proxies) live.
    if (process.platform === "darwin") {
        const extra = ["/opt/homebrew/bin", "/usr/local/bin"].filter(dir => !(env.PATH ?? "").split(":").includes(dir));
        env.PATH = [env.PATH, ...extra].filter(Boolean).join(":");
    }
    return env;
}

// A packaged app ships its own bun (scripts/package.ts); a dev run uses the one on PATH.
function bunExecutable(): string {
    const bundled = join(APP_ROOT, "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(bundled)) return bundled;
    return process.env.CATAGLYPH_BUN || "bun";
}

const startSidecar = () => new Sidecar({
    bun: bunExecutable(),
    entry: join(APP_ROOT, "bun", "index.js"),
    env: sidecarEnv(),
    host: {
        pickFolder: async ({ start }: { start: string }) => {
            const options: Electron.OpenDialogOptions = { defaultPath: start, properties: ["openDirectory"] };
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            return result.canceled ? null : result.filePaths[0] ?? null;
        },
        // shell.openPath answers with an error message, empty on success.
        openPath: async ({ path }: { path: string }) => (await shell.openPath(path)) === "",
        // https only, whatever the Bun process says: this launches the default browser.
        openUrl: async ({ url }: { url: string }) => {
            if (!url.startsWith("https://")) return false;
            await shell.openExternal(url);
            return true;
        },
        trash: async ({ paths }: { paths: string[] }) => {
            const results = [];
            for (const path of paths) {
                try {
                    await shell.trashItem(path);
                    results.push({ path, ok: true });
                } catch (err) {
                    results.push({ path, ok: false, error: err instanceof Error ? err.message : String(err) });
                }
            }
            return results;
        },
        // The view's media URLs are cached as immutable (media/server.ts), so thumbnails the
        // Bun process has long deleted can still sit here.
        browserCache: async ({ clear }: { clear: boolean }) => {
            if (clear) await session.defaultSession.clearCache();
            return session.defaultSession.getCacheSize();
        },
    },
    onMessage: (name, payload) => win?.webContents.send("rpc-message", name, payload),
    onExit: reason => {
        dialog.showErrorBox("Cataglyph", `The background process stopped unexpectedly (${reason}).`);
        app.quit();
    },
});


// A photo grid wants room, but a maximized window was too much: 80 % of the primary
// display's work area, centred. Electron reports the work area in logical pixels, so this
// is right on a fractionally scaled desktop too.
function initialBounds(): Electron.Rectangle {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.round(area.width * 0.8);
    const height = Math.round(area.height * 0.8);
    return { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
}

// macOS expects the app menu (Quit, Hide) and the Edit menu: without the latter, Cmd+C/V/A
// do nothing in text fields. Linux had no menu bar under Electrobun either.
function setMenu() {
    if (process.platform !== "darwin") {
        Menu.setApplicationMenu(null);
        return;
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        ...(DEV ? [{ role: "viewMenu" as const }] : []),
        { role: "windowMenu" },
    ]));
}

async function createWindow() {
    win = new BrowserWindow({
        ...initialBounds(),
        title: "Cataglyph",
        // style.css --bg: no white flash before the view has painted.
        backgroundColor: "#121316",
        show: false,
        // macOS takes the bundle's icon; Windows the .exe's, which only the packaged build has.
        icon: process.platform === "darwin" ? undefined : join(APP_ROOT, "icon.png"),
        webPreferences: {
            preload: join(APP_ROOT, "electron", "preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => {
        win = null;
    });
    // The view is the app's own page and never navigates; links go through openUrl.
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const devServer = process.env.CATAGLYPH_DEV_SERVER;
    if (devServer) await win.loadURL(devServer);
    else await win.loadFile(join(APP_ROOT, "view", "index.html"));
}

async function start() {
    // Started before the window so the Bun process loads while Electron does.
    const sidecar = startSidecar();

    ipcMain.handle("rpc", (event, method: string, params: unknown) => {
        if (event.sender !== win?.webContents) return { error: "unknown sender" };
        return sidecar.request(method, params);
    });

    app.on("second-instance", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    // One window is the whole app, on macOS too: closing it quits rather than leaving a dock
    // icon with nothing behind it.
    app.on("window-all-closed", () => app.quit());

    // The Bun process gets to stop Eye and exiftool and close its databases before the app
    // exits.
    let stopped = false;
    app.on("before-quit", event => {
        if (stopped) return;
        event.preventDefault();
        void sidecar.stop().finally(() => {
            stopped = true;
            app.quit();
        });
    });

    await app.whenReady();
    setMenu();
    await createWindow();
}

// Two windows on the same folder would race on its decisions; a second start focuses the first.
// Not awaited: Electron emits "ready" only after the ESM entry has finished evaluating, so a
// top-level await on whenReady() never returns (the first dev run hung with no window).
if (app.requestSingleInstanceLock()) void start();
else app.exit(0);

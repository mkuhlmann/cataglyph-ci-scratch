// Where the app keeps its files, per platform. Shared by the Bun process (db.ts, thumbnails,
// video proxies) and the Electron main process (Chromium's profile), so it imports nothing
// but Node built-ins.
//
//   Linux                                       macOS
//   $XDG_CACHE_HOME/org.mkuhlmann.cataglyph     ~/Library/Caches/org.mkuhlmann.cataglyph
//   $XDG_DATA_HOME/org.mkuhlmann.cataglyph      ~/Library/Application Support/org.mkuhlmann.cataglyph
//   $XDG_CONFIG_HOME/org.mkuhlmann.cataglyph    (same as data: macOS has no separate config dir
//                                                for anything but plists)
//
//   Windows
//   %LOCALAPPDATA%\org.mkuhlmann.cataglyph\Cache (machine-local: thumbnails, proxies, Chromium)
//   %APPDATA%\org.mkuhlmann.cataglyph            (roaming: state.db and settings.json)
//
// All named after the app identifier, which is also the macOS bundle id
// (scripts/package.ts); keep the two in step.

import { homedir } from "node:os";
import { join } from "node:path";

export const APP_ID = "org.mkuhlmann.cataglyph";

const home = homedir();
const mac = process.platform === "darwin";
const windows = process.platform === "win32";
const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
const roamingAppData = process.env.APPDATA || join(home, "AppData", "Roaming");

export const XDG_CACHE = process.env.XDG_CACHE_HOME || join(home, ".cache");
export const XDG_DATA = process.env.XDG_DATA_HOME || join(home, ".local", "share");
export const XDG_CONFIG = process.env.XDG_CONFIG_HOME || join(home, ".config");

export const CACHE_DIR = mac ? join(home, "Library", "Caches", APP_ID)
    : windows ? join(localAppData, APP_ID, "Cache")
    : join(XDG_CACHE, APP_ID);
export const DATA_DIR = mac ? join(home, "Library", "Application Support", APP_ID)
    : windows ? join(roamingAppData, APP_ID)
    : join(XDG_DATA, APP_ID);
export const CONFIG_DIR = mac || windows ? DATA_DIR : join(XDG_CONFIG, APP_ID);

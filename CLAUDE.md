# Cataglyph

Desktop app (Electron 44, Vue 3.6 Vapor view, the Bun backend as a sidecar process) to cull a
folder of new photos: gallery → Eye classification (on-device, GPU) → delete flagged items
(trash) → archive keepers as JPEG XL. Personal tool for Linux/KDE; macOS (Apple silicon) is
built and smoke-tested in CI only, not yet used on a real Mac (`docs/macos.md`).

## Layout

- `src/shared/types.ts` — the contract between main process and view (JSON-safe only).
  `src/shared/rpc.ts` — `CataglyphRPC` (view ↔ backend), `HostRequests` (backend → Electron),
  `WireMessage`.
- `src/electron/` — Electron main process: `main.ts` (window, native dialog/shell/trash, menu),
  `sidecar.ts` (starts the Bun process, relays), `preload.ts` (`window.cataglyph` bridge).
- `src/bun/` — the backend, run by Bun as a sidecar. `host.ts` is its end of the IPC channel;
  `app.ts` wires the handlers. `scan/` pairing of JPG+RAW+sidecars into items, `media/`
  thumbnails and the local file server, `meta/` exiftool, `classify/` Eye child process and
  flag rules, `apply/` step 4 (trash/unlink/RAW moves), `convert/` step 5 (port of
  `~/.local/bin/media-batch/jxl-batch.ts`), `store/` bun:sqlite and `dirs.ts` (per-platform
  data/cache/config dirs).
- `src/view/` — Vue 3.6 Vapor UI.
- `scripts/build.ts` (→ `build/app`), `dev.ts`, `package.ts` (AppImage on Linux, zip/dmg on
  macOS), `fetch-vendor.ts` — downloads + checksum-verifies cjxl 0.12, the LiteRT WebGPU
  accelerator, the Eye weights and the AppImage runtime into `vendor/` and `models/` (on macOS
  it builds a static cjxl/djxl from pinned libjxl sources instead; needs cmake).

## Architecture

View (sandboxed, `contextIsolation`) → preload `window.cataglyph` → `ipcMain` "rpc" → Node IPC
(JSON) → Bun process (`build/app/bun/index.js`), which answers with the `CataglyphRPC` handlers.
Bun pushes messages to the view the same way back. For what only Electron can do the Bun
process sends `HostRequests` to the main process: `pickFolder`, `openPath`, `openUrl`, `trash`.
The Eye child process is spawned by the Bun process (Bun IPC), not by Electron.

## Commands

```sh
bun install && bun run vendor   # deps + vendored binaries/model
bun test                        # unit tests (pure modules + fixture-based fs tests)
bun run typecheck
bun run dev                     # build + run in Electron (or `hutch run dev`)
bun run dev:hmr                 # same, view from the Vite dev server (live edits to src/view)
bun run build                   # build/app only
bun run package                 # AppImage (Linux) / zip + dmg (macOS) into artifacts/
```

`hutch run package` is the same (alias `hutch run appimage`). Output:
`artifacts/Cataglyph-<version>-linux-x86_64.AppImage` on Linux, `Cataglyph-<version>-macos-arm64.zip` (+ `.dmg`)
on macOS. Hutch needs `~/.hutch/bin` on PATH.

Releases are automated (`.github/workflows/release.yml`): release-please keeps a release PR
open that bumps `package.json` and writes `CHANGELOG.md` from the commit types; merging it tags
`vX.Y.Z`, and CI (a Linux and a `macos-15` job) attaches the AppImage and the unsigned arm64
zip + dmg, each with a `.sha256`, to the GitHub release. Never bump the version
by hand. The workflow pins Bun 1.4.4 (it ships as `bin/bun`): keep it in step with local Bun.

## Conventions

- 4-space indent, double quotes, semicolons, trailing commas. Imports use `.ts` extensions.
- Comments explain *why* and cite the concrete failure that motivated the code (house style
  of media-batch; keep long comments).
- `noUncheckedIndexedAccess` is on: narrow, don't `!`.
- Tests live in `test/*.test.ts` (bun:test). Filesystem tests work in a fresh temp dir and
  never touch real photo folders.
- Commit messages follow Conventional Commits: `type(scope): summary`, e.g. `feat: …`,
  `fix(ui): …`, `docs(readme): …`, `refactor(convert): …`, `chore: …`. No `Co-Authored-By`
  trailer.

## Invariants

- **An original is never touched before its replacement is verified.** Conversion deletes or
  moves the source still only after cjxl exited 0, the output exists and its Exif reads back.
- **Metadata is never silently lost.** exiftool copies use the explicit allowlist in
  `convert/exif.ts` (never `-all:all`, which broke Gwenview on Google Camera XMP blobs).
- **Not knowing means keeping.** A sidecar video whose pairing can't be verified is its own
  item; unknown files are ignored and never moved or deleted.
- **Manual decisions win.** Re-running the classifier only changes `source: "auto"` verdicts.

## Gotchas

- **Eye runs in a child process** (`classify/eye-process.ts`, same bundle re-entered with
  `CATAGLYPH_ROLE=eye`). LiteRT dlopens `libLiteRtWebGpuAccelerator.so` by bare name, and
  the linker reads `LD_LIBRARY_PATH` only at process start, so the GPU path needs its own
  process. Check the status line: it shows the adapter LiteRT actually selected.
- **vue-tsc doesn't run under Bun** (no Node here). SFCs are shimmed in `env.d.ts`; `bun run
  typecheck` type-checks the .ts files and lets `vite build` compile the SFCs.
- **Sandbox on Linux:** with `kernel.apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04+)
  Electron aborts unless started with `--no-sandbox` *on the command line*; appending it from
  main.js is too late. `scripts/dev.ts` and the AppImage's AppRun add it when needed.
- **No top-level `await app.whenReady()`** in the ESM main: Electron emits ready only after the
  entry module has finished evaluating, so it hangs. That's why `start()` isn't awaited.
- **View source:** `file://` (`build/app/view/index.html`), or the Vite dev server when
  `CATAGLYPH_DEV_SERVER` is set (`bun run dev:hmr`).
- **Chromium's profile** lives in `<cache dir>/chromium` (`app.setPath("userData")`), not
  Electron's default `~/.config`.
- **Which bun:** the packaged app ships its own at `resources/app/bin/bun`; dev runs use bun
  from PATH (or `CATAGLYPH_BUN`). `tools.ts` and module resolution find `vendor/`, `models/` and
  `node_modules` by walking up from `bun/index.js`.
- **`electron` has no postinstall:** the binary downloads on the first `import electron`
  (`scripts/dev.ts` does that under bun).
- **Killing a dev run:** `pkill -x electron`. Never `pkill -f` with a pattern that also appears
  in your own command line; it kills the shell.
- `.jxl` decoding in the view needs the `JXLImageFormat` feature, appended in
  `src/electron/main.ts`.
- The AppImage (`scripts/package.ts`) is the stock Electron distribution renamed to `cataglyph`
  plus `resources/app/` (the build, a pruned production `bun install`, `vendor/`, `models/`,
  `bin/bun`). Native packages (Eye core, koffi) must stay real files outside any asar. If you
  add a native dependency, make sure `package.ts` prunes/keeps the right platform directory.
  If you add a vendored file, copy it in `stageApp`.
- `Bun.Image` has no raw-pixel output and no HEIC on Linux. Raw pixels for Eye go through a
  JPEG + jpeg-js; HEIC is decoded with libheif-js and handed to Bun.Image as a BMP.
- `.jxl` files are `kind: "archived"` items. Bun.Image can't read JXL, so thumbnails, previews
  and Eye run off a full-size JPEG from the vendored `djxl`; `/original` serves the `.jxl`
  itself, which Chromium decodes because of the flag above.
- Data dirs are per platform (`store/dirs.ts`); `APP_ID` must match the macOS bundle id in
  `scripts/package.ts`.

## Testing the running app

Dev runs (`!app.isPackaged`) enable Chromium remote debugging on 127.0.0.1:9222, and
`src/view/main.ts` exposes `window.__ingest = { state, gallery }`. Drive the UI over CDP
(`Runtime.evaluate`, e.g. `__ingest.state.openFolder("/tmp/fixture")`) and grab screenshots with
`Page.captureScreenshot`. Always work on a *copy* of photos in a temp dir.

## i18n

English is the primary language, German the second (`src/view/i18n/`). `en.ts` is the source
catalog and defines `MessageKey`; `de.ts` is a complete `Record<MessageKey, string>`, and
`test/i18n.test.ts` checks both have the same keys and placeholders. The backend sends
language-neutral data (tag names, `Reason` objects, metadata label keys, file roles) and the
view renders it with `t()` / `tagLabel()`. "auto" language uses `InitInfo.systemLocale`: Electron's
`app.getPreferredSystemLanguages()`, passed to the Bun process as `CATAGLYPH_LOCALE` (POSIX
`LC_ALL`/`LC_MESSAGES`/`LANG` as fallback; `app.ts`). `navigator.language` is not used as the source.

## Licensing

Cataglyph's code is MIT. Eye (SDK + weights) is under the Desert Ant Labs Source-Available
License 1.0 (https://license.desertant.com/1.0), see `THIRD_PARTY_NOTICES.md`. Rules from it:
- Keep the attribution: "Powered by Eye from Desert Ant Labs 🐜" on the start screen
  (`StartScreen.vue`, links to desertant.com/models/eye), and "Powered by Desert Ant Labs 🐜"
  in the toolbar while an analysis runs (`Toolbar.vue`).
- Never disable, block or proxy the SDK's usage telemetry (§6). Never commit the weights;
  `models/` is gitignored and `bun run vendor` fetches them along with their `LICENSE.md`.
- Keep the license files of bundled binaries (`vendor/jxl/LICENSE.*`, `vendor/litert/LICENSE`,
  `models/LICENSE.md`, `node_modules/*/LICENSE*`). The AppImage ships them.

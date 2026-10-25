# Cataglyph

Named after *Cataglyphis*, the genus of desert ants (Eye, the classifier, comes from Desert Ant Labs), plus *glyph*: an image, a sign.

Desktop app for culling a folder of new photos and archiving the keepers as JPEG XL.

<p>
  <img src="docs/screenshots/overview.webp" width="49%" alt="Gallery after analysis: blurry shots and duplicates flagged for deletion, bursts stacked, RAW badges">
  <img src="docs/screenshots/detail.webp" width="49%" alt="Detail view: why a shot is flagged, Eye's ratings and tags, metadata, and the burst it belongs to">
</p>

1. **Open a folder.** JPG+RAW (Sony ARW, phone DNG), HEIC, Live/Motion Photos, videos and
   sidecars (`.pp3`, `.xmp`) are grouped into items. The JPG is shown, the RAW appears as a
   badge.
2. **Review.** The grid is virtualized; the detail view (Enter / double-click) shows
   metadata, Eye tags, scores, a blur map and faces. `Z` zooms to 100%.
3. **Analyze** with [Eye](https://desertant.com/models/eye/) (on-device, LiteRT). Analysis runs
   on the GPU through LiteRT's WebGPU accelerator (Dawn → Vulkan). If that is unavailable, it
   falls back to the CPU automatically. Blurry and failed shots are suggested for deletion.
   Duplicates and bursts are stacked, and the best photo of each stack is kept.
4. **Clean up.** Items marked for deletion go to the KDE trash (or are deleted permanently,
   if you prefer). The RAW is deleted by default; with "Keep RAW" (`R`) it is moved to
   `RAW/` instead.
5. **Archive.** Kept images are converted to JXL with the bundled cjxl 0.12 (default:
   lossy d1.0 e7, `DSC00153_lossy_d1.0.jxl`). The original is only deleted or moved to
   `originals/` once the JXL's EXIF data has been verified. Analyses and decisions carry
   over to the JXL.

<p>
  <img src="docs/screenshots/cleanup.webp" width="49%" alt="Clean-up dialog: what goes to the trash, which RAWs move to RAW/, and how much space is freed, before anything is touched">
  <img src="docs/screenshots/archive.webp" width="49%" alt="Archive summary: 17 images converted to JPEG XL, 158.6 MB down to 54.5 MB">
</p>

## Keyboard

| Key | Action |
|---|---|
| Arrow keys | Move selection |
| `C` / `X` / Space | keep / delete / toggle |
| `R` | Toggle keeping the RAW |
| `U` | Undo a manual decision |
| `S` | Expand/collapse stack |
| `Enter`, `Esc` | Open/close detail view |
| `Z`, `B`, `F` | Detail: zoom 100%, blur map, faces |
| `↓` / `↑` | Detail: step through the current stack with `←`/`→` / back to the gallery |

## Setup

```sh
bun install
bun run vendor        # cjxl 0.12, LiteRT GPU accelerator, Eye weights (SHA-256 verified)
bun run dev           # build + start the app in Electron (or: hutch run dev)
bun run dev:hmr       # same, with the view served by Vite (live edits to src/view)
```

Electron's binary is downloaded on the first run. The app is an Electron shell (window,
dialogs, trash) around a Bun backend that runs as a separate process.

`bun test` runs the unit and filesystem tests; `bun run typecheck` checks the types
and builds the view.

## Packaging

```sh
bun run package       # or: hutch run package (alias: hutch run appimage)
```

On Linux this writes `artifacts/Cataglyph-<version>-linux-x86_64.AppImage` (~233 MB). The image
contains Electron, Bun, the native Eye core with the GPU accelerator, the model, cjxl and
exiftool. The host still needs `perl` with `IO::Uncompress::Brotli` (Debian/Ubuntu:
`libio-compress-brotli-perl`): cjxl Brotli-compresses the Exif it writes, and without the
module exiftool can't update it, so the EXIF self-test stops every conversion. Install `ffmpeg` too if you want video thumbnails.
Building needs `squashfs-tools`. On Ubuntu 24.04+ (AppArmor restricts unprivileged user
namespaces) the AppImage starts Electron with `--no-sandbox`.

On macOS (Apple silicon) it writes `artifacts/Cataglyph-<version>-macos-arm64.zip` and `.dmg`
(unsigned). `bun run vendor` builds cjxl/djxl from source there, which needs cmake. The build
is tested in CI but hasn't been used on a real Mac yet; see [`docs/macos.md`](docs/macos.md).

Releases come from GitHub Actions: commits follow Conventional Commits, release-please keeps a
release PR with the next version and changelog, and merging it publishes a GitHub release with
the AppImage and the macOS zip + dmg attached, each with its SHA-256 checksum.

## Data

- Linux: `~/.cache/org.mkuhlmann.cataglyph/`: thumbnails, analysis cache, 720p AV1 video proxies, and
  Chromium's profile in `chromium/` (safe to delete)
- `~/.local/share/org.mkuhlmann.cataglyph/state.db`: your decisions per folder
- `~/.config/org.mkuhlmann.cataglyph/settings.json`: settings

On macOS the cache is `~/Library/Caches/org.mkuhlmann.cataglyph/`, and state and settings are in
`~/Library/Application Support/org.mkuhlmann.cataglyph/`.

In the photo folder itself, the app only creates `RAW/` and `originals/`.

## Notes

- HDR gain maps (Ultra HDR on Pixel/Samsung) do not survive the JXL conversion. Such
  images get an `HDR` badge.
- Videos play in the detail view. The bundled Chromium can't decode H.264/HEVC/AAC, so
  such clips are converted once into a 720p AV1 proxy, on the GPU via VAAPI when available.
  This needs `ffmpeg`/`ffprobe` on the host. AV1/VP9 clips play directly.
- Already archived `.jxl` files show up as items with a `JXL` badge: analyzed and cleaned up
  like any photo (a RAW or sidecar left beside them still pairs), never converted again. A
  JPG next to its own JXL belongs to the JXL's item and is deleted with it.
- Motion Photo videos are discarded by default. "Extract" (archive dialog) writes them as
  a separate video file next to the JXL.

## License

Cataglyph is MIT-licensed (see [`LICENSE`](LICENSE)). The MIT license does **not** cover the
Eye model and SDK.

Photo analysis is powered by [Eye by Desert Ant Labs](https://desertant.com). Eye is under
the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0):
free below 100,000 monthly active devices per platform, and no training of competing
models on its outputs. The SDK sends Desert Ant Labs a minimal usage signal so they can
count active devices. It never contains your photos, analysis results, or other content.

`bun run vendor` downloads the weights from Hugging Face. The repository does not contain
them. All other bundled components are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

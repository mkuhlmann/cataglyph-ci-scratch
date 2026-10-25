# Windows (x64)

Status: the release workflow builds, tests and packages it on GitHub's `windows-2025` runners,
and the packaged app was started there (opened a folder, Eye analysed it on the CPU). Nobody
has used it on a real PC yet.

## How it works

- **Eye:** `@desert-ant-labs/eye` ships native cores for linux-x64, linux-arm64 and
  darwin-arm64 only. Desert Ant Labs' Swift source builds for Windows (their CI does), so
  `bun run vendor` builds `EyeNode.dll` from the desert-ant-core v4.1.0 tag (`buildEyeWindows`
  in `scripts/fetch-vendor.ts`) against `libLiteRt.dll` from Google's win_amd64 LiteRT 2.3.0
  wheel: the same LiteRT path as Linux. Two changes to their build, both permitted by the
  license (section 2, "use, reproduce, and modify"); telemetry is untouched:
  - The `onnxProducts` edge is dropped from the `Inference` target. Only Voz uses ONNX Runtime
    (`OnnxSession.swift` is behind `#if canImport(COnnxRuntime)`); with the edge the link
    needs `onnxruntime.lib` and the DLL would import `onnxruntime.dll`, which Windows ML's
    older copy in System32 shadows.
  - `/EXPORT` for the C ABI koffi binds (`EYE_EXPORTS`): the `dal_*` functions come from
    static libraries, and a DLL exports nothing of those unless told to.
- Swift 6.2 has no static stdlib on Windows, so `vendor/eye/win32-x64/` carries the Swift
  runtime DLLs (Foundation and `_FoundationICU` are most of its ~70 MB) and the MSVC C++
  runtime, app-local. `fetch-vendor.ts` copies the directory into
  `node_modules/@desert-ant-labs/eye/native/win32-x64`, where the loader looks; `package.ts`
  into the app's own install.
- Windows looks for a DLL's dependencies on `PATH`, not next to the DLL, so the Eye child
  process gets that directory on `PATH` (`eye-client.ts`), the counterpart of
  `LD_LIBRARY_PATH` on Linux.
- cjxl/djxl: libjxl's static x64 release. Its zip uses Deflate64, which only PowerShell 7's
  `Expand-Archive` unpacks (not Windows' `tar`).
- exiftool: `exiftool-vendored.exe` (a bundled Perl, including the Brotli module cjxl's Exif
  needs), installed by bun on win32 only.
- Trash: the Recycle Bin, through Electron's `shell.trashItem` (as on macOS).
- Data: `%LOCALAPPDATA%\org.mkuhlmann.cataglyph\Cache` (thumbnails, proxies, Chromium) and
  `%APPDATA%\org.mkuhlmann.cataglyph` (state.db, settings.json).
- Packaging: `@electron/packager` (icon and version resources via resedit, ICO written from
  `assets/cataglyph-1024.png`), zipped with Windows' bsdtar into
  `artifacts/Cataglyph-<version>-windows-x64.zip`. Portable: unpack, run `Cataglyph.exe`.

## Building locally

- Bun 1.4.4, PowerShell 7 (`pwsh`), the Swift 6.2.1 toolchain (https://www.swift.org/install/windows/)
  and Visual Studio with "Desktop development with C++".
- Run `bun run vendor` from an "x64 Native Tools" prompt (it reads `VCToolsRedistDir` for the
  C++ runtime). The Eye build takes a few minutes, once.
- ffmpeg is optional, as elsewhere: on `PATH` for video posters and proxies.

## Open

a. **GPU:** `vendor/litert/libLiteRtWebGpuAccelerator.dll` (Dawn on D3D12) goes on the GPU
   process's `PATH`, and LiteRT does select it: on the CI runner, which has no GPU, the
   status line read "Microsoft Basic Render Driver, Direct3D" (Windows' software renderer).
   Not seen on real hardware yet.
b. **Signing:** the build is unsigned; SmartScreen warns on first start ("More info" >
   "Run anyway").
c. **C++ runtime precedence:** Windows searches System32 before `PATH`, so an older
   `MSVCP140.dll` installed there wins over the app-local one.
d. **NTFS:** case-insensitive like APFS; pairing (`src/bun/scan/pairing.ts`) has not been
   checked against that.
e. **Installer:** none yet, only the zip.

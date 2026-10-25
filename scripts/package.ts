// Packages the app for the host platform: `bun run scripts/package.ts` (`hutch run package`).
//
//   Linux    artifacts/Cataglyph-<version>-linux-x86_64.AppImage
//   macOS    artifacts/Cataglyph-<version>-macos-arm64.zip (+ .dmg when hdiutil exists)
//   Windows  artifacts/Cataglyph-<version>-windows-x64.zip (portable, unsigned)
//
// Packaging always runs on the target OS: macOS needs codesign/hdiutil/ditto anyway, and the
// native packages (Eye's LiteRT core, koffi) are pruned to the host's platform.
//
// Both targets ship the same `resources/app/` tree. The Electron main process (a thin shell)
// starts the Bun backend as a sidecar, `resources/app/bin/bun resources/app/bun/index.js`, and
// tools.ts plus Node module resolution find these by walking up from resources/app/bun/:
//
//   (build/app)     package.json, electron/main.js + preload.cjs, bun/index.js, view/, icon.png
//   node_modules    production deps only, pruned to this platform. Eye's native core and koffi
//                   find their .so/.dylib/.node files relative to their own package directory,
//                   so they can't be bundled into index.js. Not asar'd either: Bun can't read
//                   an asar and the native files must be real files.
//   bin/bun(.exe)   a copy of the Bun that runs this script, so the app needs no Bun on PATH
//   vendor          cjxl, djxl (and the LiteRT GPU accelerator on Linux and Windows), with their
//                   licenses
//
// Windows also gets Eye's native core, which Desert Ant Labs doesn't publish for win32: the
// EyeNode.dll that fetch-vendor.ts builds from their source (vendor/eye/win32-x64, with
// libLiteRt.dll and the Swift and MSVC runtime DLLs) goes into Eye's native/win32-x64.
//   models          the Eye weights and the Desert Ant Labs license they came with
//   LICENSE, THIRD_PARTY_NOTICES.md
//
// Not bundled, expected on the host: perl (exiftool; on Windows exiftool-vendored ships an .exe
// with its own Perl) and, optionally, ffmpeg.

import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build } from "./build.ts";

const ROOT = resolve(import.meta.dir, "..");
const WORK = join(ROOT, "build", "package");
const STAGE = join(WORK, "app");
const ARTIFACTS = join(ROOT, "artifacts");

const platform = process.platform;
const arch = process.arch;

if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new Error(`unsupported platform ${platform}`);
if (platform === "linux" && arch !== "x64") throw new Error("the AppImage is only built for x86_64");
if (platform === "darwin" && arch !== "arm64") throw new Error("the macOS build is only made for Apple silicon (arm64)");
if (platform === "win32" && arch !== "x64") throw new Error("the Windows build is only made for x64");

const windows = platform === "win32";
const exe = (name: string) => windows ? `${name}.exe` : name;

const pkg = await Bun.file(join(ROOT, "package.json")).json() as { version: string };

async function run(cmd: string[], cwd: string = ROOT): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

async function need(path: string, hint: string): Promise<void> {
    if (!await Bun.file(path).exists()) throw new Error(`${path} missing: ${hint}`);
}

// What a production install carries that this platform never loads. Eye's dist/ is the
// browser/wasm build (imported lazily, only for the wasm accelerator); together with the other
// platforms' native directories these are ~130 MB of the ~250 MB a plain install weighs.
// Directory names differ per package: Eye uses `linux-x64`, koffi `linux_x64`.
const EYE_NATIVE = `${platform}-${arch}`;
const KOFFI_BUILD = `${platform}_${arch}`;
const PRUNE = [
    "@desert-ant-labs/eye/dist",
    "koffi/doc",
    "koffi/src",
    "koffi/vendor",
];

async function installDeps() {
    const staging = join(WORK, "deps");
    await mkdir(staging, { recursive: true });
    await copyFile(join(ROOT, "package.json"), join(staging, "package.json"));
    await copyFile(join(ROOT, "bun.lock"), join(staging, "bun.lock"));
    // --production leaves devDependencies out, which is what keeps `electron` (hundreds of MB,
    // and the packaged app brings its own runtime) and the build tooling out of the app.
    await run([process.execPath, "install", "--production", "--frozen-lockfile"], staging);

    const modules = join(staging, "node_modules");
    for (const rel of PRUNE) await rm(join(modules, rel), { recursive: true, force: true });
    const eyeNative = join(modules, "@desert-ant-labs", "eye", "native");
    if (windows) {
        const built = join(ROOT, "vendor", "eye", EYE_NATIVE);
        await need(join(built, "EyeNode.dll"), "run `bun run vendor` (builds Eye's native core; needs the Swift toolchain)");
        await cp(built, join(eyeNative, EYE_NATIVE), { recursive: true });
    }
    for (const dir of await readdir(eyeNative)) {
        if (dir !== EYE_NATIVE) await rm(join(eyeNative, dir), { recursive: true, force: true });
    }
    if (!existsSync(join(eyeNative, EYE_NATIVE))) throw new Error(`Eye has no native build for ${EYE_NATIVE}`);
    const koffiBuilds = join(modules, "koffi", "build", "koffi");
    for (const dir of await readdir(koffiBuilds)) {
        if (dir !== KOFFI_BUILD) await rm(join(koffiBuilds, dir), { recursive: true, force: true });
    }
    if (!existsSync(join(koffiBuilds, KOFFI_BUILD))) throw new Error(`koffi has no build for ${KOFFI_BUILD}`);
    await rm(join(modules, "electron"), { recursive: true, force: true });
    await cp(modules, join(STAGE, "node_modules"), { recursive: true });
}

async function stageApp() {
    await cp(join(ROOT, "build", "app"), STAGE, { recursive: true });
    await installDeps();

    await mkdir(join(STAGE, "bin"), { recursive: true });
    await copyFile(process.execPath, join(STAGE, "bin", exe("bun")));
    await chmod(join(STAGE, "bin", exe("bun")), 0o755);

    const jxl = join(ROOT, "vendor", "jxl");
    const jxlHint = platform === "darwin"
        ? "run `bun run vendor` (builds a static cjxl/djxl from source; needs cmake)"
        : "run `bun run vendor`";
    await need(join(jxl, exe("cjxl")), jxlHint);
    await need(join(jxl, exe("djxl")), jxlHint);
    await mkdir(join(STAGE, "vendor", "jxl"), { recursive: true });
    for (const bin of [exe("cjxl"), exe("djxl")]) {
        await copyFile(join(jxl, bin), join(STAGE, "vendor", "jxl", bin));
        await chmod(join(STAGE, "vendor", "jxl", bin), 0o755);
    }
    for (const name of await readdir(jxl)) {
        if (name.startsWith("LICENSE.")) await copyFile(join(jxl, name), join(STAGE, "vendor", "jxl", name));
    }
    // The LiteRT WebGPU accelerator (.so on Linux, .dll on Windows); on macOS Eye falls back to
    // what its own native core ships, so the directory is optional there.
    const litert = join(ROOT, "vendor", "litert");
    if (existsSync(litert)) await cp(litert, join(STAGE, "vendor", "litert"), { recursive: true });
    else if (platform === "linux") throw new Error(`${litert} missing: run \`bun run vendor\``);

    await mkdir(join(STAGE, "models"), { recursive: true });
    for (const name of ["eye.tflite", "eye_meta.json", "LICENSE.md"]) {
        await need(join(ROOT, "models", name), "run `bun run vendor`");
        await copyFile(join(ROOT, "models", name), join(STAGE, "models", name));
    }
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
        await copyFile(join(ROOT, name), join(STAGE, name));
    }
}

// ---------------------------------------------------------------------------------------------
// Linux: AppImage
// ---------------------------------------------------------------------------------------------

async function packageLinux() {
    const runtime = join(ROOT, "vendor", "appimage", "runtime-x86_64");
    await need(runtime, "run `bun run vendor`");
    const appDir = join(WORK, "Cataglyph.AppDir");
    const app = join(appDir, "cataglyph");

    // The electron package has no postinstall: importing it downloads the binary into
    // node_modules/electron/dist when that is missing, as in a fresh CI checkout.
    await import("electron");
    // The stock Electron distribution is already a relocatable directory. Everything stays,
    // including chrome-sandbox, locales and the Chromium license pages (LICENSES.chromium.html
    // has to ship with the binary).
    await cp(join(ROOT, "node_modules", "electron", "dist"), app, { recursive: true });
    // A different executable name so the process shows up as "cataglyph", not "electron".
    await run(["mv", join(app, "electron"), join(app, "cataglyph")]);
    // With default_app.asar present Electron would still prefer resources/app, but it is dead
    // weight.
    await rm(join(app, "resources", "default_app.asar"), { force: true });
    await cp(STAGE, join(app, "resources", "app"), { recursive: true });

    await writeFile(join(appDir, "AppRun"), [
        "#!/bin/sh",
        'HERE="$(dirname "$(readlink -f "$0")")"',
        "# Chromium's sandbox can't work inside an AppImage: its FUSE mount is nosuid, so",
        "# chrome-sandbox can never be setuid root, and on Ubuntu 24.04+",
        "# kernel.apparmor_restrict_unprivileged_userns=1 blocks the user-namespace sandbox as",
        "# well. Electron then aborts with \"The SUID sandbox helper binary was found, but is not",
        "# configured correctly\". The flag has to be on the command line: appending it from",
        "# main.js is too late, the zygote has already been started.",
        'SANDBOX=""',
        'if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \\',
        '    || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then',
        '    SANDBOX="--no-sandbox"',
        "fi",
        'exec "$HERE/cataglyph/cataglyph" $SANDBOX "$@"',
        "",
    ].join("\n"));
    await chmod(join(appDir, "AppRun"), 0o755);
    await writeFile(join(appDir, "cataglyph.desktop"), [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Cataglyph",
        "Comment=Cull new photos on-device and archive the keepers as JPEG XL",
        "Exec=cataglyph",
        "Icon=cataglyph",
        "Terminal=false",
        "Categories=Graphics;Photography;",
        "StartupWMClass=Cataglyph",
        `X-AppImage-Version=${pkg.version}`,
        "",
    ].join("\n"));
    await copyFile(join(ROOT, "assets", "cataglyph.png"), join(appDir, "cataglyph.png"));
    await copyFile(join(ROOT, "assets", "cataglyph.png"), join(appDir, ".DirIcon"));
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
        await copyFile(join(ROOT, name), join(appDir, name));
    }

    // An AppImage is the type2 runtime followed by a squashfs of the AppDir; the runtime mounts
    // the image at its own end. This is what appimagetool does, without needing appimagetool
    // (itself an AppImage) to run.
    const squash = join(WORK, "app.squashfs");
    await run([
        "mksquashfs", appDir, squash,
        "-root-owned", "-noappend", "-no-progress", "-quiet",
        "-comp", "zstd", "-Xcompression-level", "19", "-b", "1M",
    ]);
    await mkdir(ARTIFACTS, { recursive: true });
    const out = join(ARTIFACTS, `Cataglyph-${pkg.version}-linux-x86_64.AppImage`);
    // Streamed piece by piece: Bun.write of a Blob made of two Bun.file()s writes 0 bytes.
    const writer = Bun.file(out).writer();
    for (const part of [runtime, squash]) {
        for await (const chunk of Bun.file(part).stream()) writer.write(chunk);
    }
    await writer.end();
    await chmod(out, 0o755);
    return [out];
}

// ---------------------------------------------------------------------------------------------
// macOS: .app via @electron/packager, then zip (+ dmg)
// ---------------------------------------------------------------------------------------------

// ICNS is 'icns', a big-endian u32 total length, then entries of a 4-char type, a u32 length
// (including the 8 header bytes) and PNG data. ic10 is 1024 px (512@2x); the rest are 1x sizes.
const ICNS_TYPES: [string, number][] = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
];

// assets/cataglyph-1024.png was rendered once from assets/cataglyph.svg with
// `convert -background none -density 384 assets/cataglyph.svg -resize 1024x1024 assets/cataglyph-1024.png`
// (the 256 px cataglyph.png would be blurry at 512/1024), so the icon needs no rasterizer here.
async function writeIcns(path: string) {
    const source = join(ROOT, "assets", "cataglyph-1024.png");
    const entries: Uint8Array[] = [];
    for (const [type, size] of ICNS_TYPES) {
        const png = await new Bun.Image(source).resize(size, size).png().bytes();
        const header = new Uint8Array(8);
        header.set(new TextEncoder().encode(type));
        new DataView(header.buffer).setUint32(4, png.length + 8);
        entries.push(header, png);
    }
    const total = 8 + entries.reduce((n, e) => n + e.length, 0);
    const file = new Uint8Array(total);
    file.set(new TextEncoder().encode("icns"));
    new DataView(file.buffer).setUint32(4, total);
    let offset = 8;
    for (const entry of entries) {
        file.set(entry, offset);
        offset += entry.length;
    }
    await Bun.write(path, file);
}

async function packageMac() {
    const { packager } = await import("@electron/packager");
    const electronVersion = (await Bun.file(join(ROOT, "node_modules", "electron", "package.json")).json() as { version: string }).version;
    const icon = join(WORK, "cataglyph");
    await writeIcns(`${icon}.icns`);

    const identity = process.env.CATAGLYPH_MAC_SIGN_IDENTITY;
    const notaryProfile = process.env.CATAGLYPH_NOTARY_PROFILE;
    if (notaryProfile && !identity) throw new Error("CATAGLYPH_NOTARY_PROFILE needs CATAGLYPH_MAC_SIGN_IDENTITY");

    const outDir = join(ROOT, "build", "mac");
    await rm(outDir, { recursive: true, force: true });
    const [appRoot] = await packager({
        dir: STAGE,
        out: outDir,
        name: "Cataglyph",
        electronVersion,
        platform: "darwin",
        arch: "arm64",
        // The Bun sidecar needs real files (it can't read an asar).
        asar: false,
        // node_modules was staged above as a pruned production install; packager's own prune
        // would need the full dependency tree to be resolvable.
        prune: false,
        overwrite: true,
        appBundleId: "org.mkuhlmann.cataglyph",
        appCategoryType: "public.app-category.photography",
        // Without extension: packager appends .icns itself (and probes .icon, the Icon Composer
        // format, hence a harmless "could not find .icon" warning); with ".icns" it looks for
        // "cataglyph.icns.icns" and the app silently keeps Electron's icon.
        icon,
        // @electron/osx-sign walks every file in the bundle and signs each Mach-O one (found by
        // content, not extension), so the extra binaries resources/app/bin/bun, vendor/jxl/cjxl
        // and djxl, *.dylib and *.node are signed in the same pass, inside-out, with the same
        // identity, hardened runtime and entitlements. No `binaries` list is needed.
        ...identity ? {
            osxSign: {
                identity,
                optionsForFile: () => ({
                    hardenedRuntime: true,
                    entitlements: join(ROOT, "assets", "entitlements.mac.plist"),
                }),
            },
        } : {},
        ...notaryProfile ? { osxNotarize: { keychainProfile: notaryProfile } } : {},
    });
    if (!appRoot) throw new Error("@electron/packager produced no output");
    const appPath = join(appRoot, "Cataglyph.app");

    await mkdir(ARTIFACTS, { recursive: true });
    // ditto keeps the symlinks and extended attributes inside the bundle; a plain zip flattens
    // the Electron Framework's symlinks and the app no longer starts.
    const zip = join(ARTIFACTS, `Cataglyph-${pkg.version}-macos-arm64.zip`);
    await rm(zip, { force: true });
    await run(["ditto", "-c", "-k", "--keepParent", appPath, zip]);
    const outputs = [zip];

    if (Bun.which("hdiutil")) {
        const dmgDir = join(WORK, "dmg");
        await rm(dmgDir, { recursive: true, force: true });
        await mkdir(dmgDir, { recursive: true });
        await run(["ditto", appPath, join(dmgDir, "Cataglyph.app")]);
        await symlink("/Applications", join(dmgDir, "Applications"));
        const dmg = join(ARTIFACTS, `Cataglyph-${pkg.version}-macos-arm64.dmg`);
        await run(["hdiutil", "create", "-volname", "Cataglyph", "-srcfolder", dmgDir, "-ov", "-format", "UDZO", dmg]);
        outputs.push(dmg);
    }
    if (!identity) {
        console.log("Note: this build is unsigned (set CATAGLYPH_MAC_SIGN_IDENTITY to sign). Gatekeeper will refuse to open it until you choose \"Open Anyway\" in System Settings > Privacy & Security.");
    } else if (!notaryProfile) {
        console.log("Note: signed but not notarized (set CATAGLYPH_NOTARY_PROFILE to a `xcrun notarytool store-credentials` profile).");
    }
    return outputs;
}

// ---------------------------------------------------------------------------------------------
// Windows: folder via @electron/packager, then a portable zip
// ---------------------------------------------------------------------------------------------

// ICO is a little-endian ICONDIR (reserved 0, type 1, count), one 16-byte entry per image
// (width and height as a byte, 0 meaning 256; planes 1; 32 bpp; size and offset of the data),
// then the images. Windows Vista+ reads PNG data in an ICO, so no BMP encoding is needed.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function writeIco(path: string) {
    const source = join(ROOT, "assets", "cataglyph-1024.png");
    const pngs: Uint8Array[] = [];
    for (const size of ICO_SIZES) pngs.push(await new Bun.Image(source).resize(size, size).png().bytes());
    const headerSize = 6 + 16 * pngs.length;
    const file = new Uint8Array(headerSize + pngs.reduce((n, p) => n + p.length, 0));
    const view = new DataView(file.buffer);
    view.setUint16(2, 1, true);
    view.setUint16(4, pngs.length, true);
    let offset = headerSize;
    pngs.forEach((png, i) => {
        const size = ICO_SIZES[i] ?? 0;
        const entry = 6 + 16 * i;
        view.setUint8(entry, size >= 256 ? 0 : size);
        view.setUint8(entry + 1, size >= 256 ? 0 : size);
        view.setUint16(entry + 4, 1, true);
        view.setUint16(entry + 6, 32, true);
        view.setUint32(entry + 8, png.length, true);
        view.setUint32(entry + 12, offset, true);
        file.set(png, offset);
        offset += png.length;
    });
    await Bun.write(path, file);
}

async function packageWindows() {
    const { packager } = await import("@electron/packager");
    const electronVersion = (await Bun.file(join(ROOT, "node_modules", "electron", "package.json")).json() as { version: string }).version;
    const icon = join(WORK, "cataglyph");
    await writeIco(`${icon}.ico`);

    const outDir = join(ROOT, "build", "win");
    await rm(outDir, { recursive: true, force: true });
    const [appRoot] = await packager({
        dir: STAGE,
        out: outDir,
        name: "Cataglyph",
        // Cataglyph.exe; packager sets the icon and version resources with resedit (no wine).
        executableName: "Cataglyph",
        electronVersion,
        platform: "win32",
        arch: "x64",
        // As on macOS: the Bun sidecar can't read an asar, and node_modules is pruned already.
        asar: false,
        prune: false,
        overwrite: true,
        icon,
        win32metadata: {
            CompanyName: "Manuel Kuhlmann",
            FileDescription: "Cataglyph",
            ProductName: "Cataglyph",
        },
    });
    if (!appRoot) throw new Error("@electron/packager produced no output");

    // A folder named after the app, so unpacking the zip gives "Cataglyph\Cataglyph.exe".
    const folder = join(outDir, "Cataglyph");
    await rename(appRoot, folder);
    await mkdir(ARTIFACTS, { recursive: true });
    const zip = join(ARTIFACTS, `Cataglyph-${pkg.version}-windows-x64.zip`);
    await rm(zip, { force: true });
    // Windows' bsdtar writes a zip when the name says so (-a); GNU tar from Git can't.
    await run([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-a", "-cf", zip, "-C", outDir, "Cataglyph"]);
    console.log("Note: this build is unsigned. SmartScreen warns on first start (\"More info\" > \"Run anyway\").");
    return [zip];
}

await build();
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await stageApp();
const outputs = platform === "linux" ? await packageLinux() : platform === "darwin" ? await packageMac() : await packageWindows();
await rm(WORK, { recursive: true, force: true });
for (const out of outputs) {
    console.log(`✓ ${out} (${(Bun.file(out).size / 1024 / 1024).toFixed(0)} MB)`);
}

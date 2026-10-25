// Fetches the third-party binaries the app bundles, verifying every download against a
// pinned SHA-256 before anything is unpacked. Run once after cloning: `bun run vendor`.
//
//   vendor/jxl/cjxl, djxl, LICENSE.*             libjxl 0.12.0 static release (macOS: built)
//   vendor/litert/libLiteRtWebGpuAccelerator.so  LiteRT 2.3.0 GPU accelerator (Dawn -> Vulkan)
//   models/eye.tflite, eye_meta.json, LICENSE.md Eye v1.0.0 weights (skipped when present)
//   vendor/appimage/runtime-x86_64               AppImage type2 runtime (packaging only)
//
// Why each one is vendored rather than taken from the system:
// - cjxl: Ubuntu/Neon ship libjxl 0.7.0, which logs that it embedded Exif on lossy re-encodes
//   and silently writes nothing. See media-batch's jxl-batch for the original finding.
// - The LiteRT accelerator: Eye's native core links LiteRT but ships CPU-only. LiteRT dlopens
//   libLiteRtWebGpuAccelerator.so by name when it is on LD_LIBRARY_PATH, which moves
//   inference onto the GPU (measured on a Radeon 890M: ~115 ms/photo vs ~280 ms on the CPU).
//   The official ai-edge-litert wheel is the only Linux build of it Google publishes.
// - The AppImage runtime: scripts/build-appimage.ts prepends it to a squashfs of the app
//   itself (mksquashfs from squashfs-tools), so packaging needs no appimagetool, which is an
//   AppImage of its own and wants FUSE just to run.
//
// On macOS cjxl/djxl are built from source instead (libjxl publishes no macOS binaries; see
// buildCjxlMac, needs cmake and the Xcode command line tools, a few minutes), the accelerator
// above is a Linux .so, and the AppImage runtime is for Linux packaging only.
//
// Each binary keeps the license files it was released with (BSD/Apache notices travel with
// redistributed binaries; the Desert Ant Labs license requires keeping its file with the
// weights), and build-appimage.ts ships them next to the binaries.

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const LIBJXL = {
    url: "https://github.com/libjxl/libjxl/releases/download/v0.12.0/jxl-linux-x86_64-static.tar.lz",
    sha256: "5318a1ea40adad76d023e0c17a03d4627f8282f83cb2b575e69be8e74f1ff456",
};

const LITERT_WHEEL = {
    url: "https://files.pythonhosted.org/packages/94/db/defacfb96eb7ddf6145dc6bc0b0c64bc221364e413662ef8216bae8258e8/ai_edge_litert-2.3.0-cp312-cp312-manylinux_2_27_x86_64.whl",
    sha256: "dc9f56c23e0dcf182b6c35f23fbb102ed048296588882b806d5eff7654c04c88",
    member: "ai_edge_litert/libLiteRtWebGpuAccelerator.so",
    license: "ai_edge_litert-2.3.0.dist-info/licenses/LICENSE",
};

// macOS: libjxl publishes no macOS binaries, and Homebrew's cjxl is linked against Homebrew's
// dylibs (/opt/homebrew/opt/...), so it won't run on a Mac without the same Homebrew. cjxl/djxl
// are built from the v0.12.0 source instead, with every dependency linked statically: the
// third_party/ sources libjxl's deps.sh pins for this tag (GitHub's source tarball leaves the
// submodules out; tests, gtest and testdata are not needed), libpng + zlib bundled by
// libjxl's own JPEGXL_BUNDLE_LIBPNG, and a static libjpeg-turbo for JPEG in/out (libjxl finds
// libjpeg with find_package(JPEG) and would otherwise pick up Homebrew's dylib). The result
// only links /usr/lib/libSystem and libc++, which buildCjxlMac checks with otool.
const LIBJXL_SOURCE = {
    url: "https://github.com/libjxl/libjxl/archive/refs/tags/v0.12.0.tar.gz",
    sha256: "03e9be69a30be4011f559da75328b6d7cea8ad921fabfbd551ce10bf45cdc992",
    thirdParty: [
        // dir under third_party/, GitHub repo, commit from deps.sh at v0.12.0, tarball digest
        ["brotli", "google/brotli", "028fb5a23661f123017c060daa546b55cf4bde29", "0afe09a53c8bad9861c8dd1fc1284308d54f19d2979ba3541cfdcc9b05fe360f"],
        ["highway", "google/highway", "457c891775a7397bdb0376bb1031e6e027af1c48", "5124b0501c98d9930dbb065bfa1a5bbbd59ce0f12facb7e1e33aaef01a5f1f1a"],
        ["skcms", "google/skcms", "96d9171c94b937a1b5f0293de7309ac16311b722", "9bb4b5bba0b7c04f6c2bce9ff713d61e23c9a20c4945161ae16290498ad74627"],
        ["sjpeg", "webmproject/sjpeg", "94e0df6d0f8b44228de5be0ff35efb9f946a13c9", "ac94917fe745a674eabf1e044f23ec55cd5a548c9869c06ec4b19da14ee0227d"],
        ["zlib", "madler/zlib", "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf", "d9e270d46252734aa49770fbc544125391617956266f220bd63216c834f3a522"],
        ["libpng", "glennrp/libpng", "872555f4ba910252783af1507f9e7fe1653be252", "f7ebcdc408a26d45244d9ef3d35d732a5482a77c55d1d40bf1eb748030691097"],
    ] as const,
};

const LIBJPEG_TURBO = {
    url: "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz",
    sha256: "6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e",
};

// The oldest macOS the binaries run on; Electron 44 itself needs macOS 12.
const MACOS_DEPLOYMENT_TARGET = "12.0";

// GitHub publishes no digest for this release asset; the hash pins what was downloaded and
// checked when the release was adopted.
const APPIMAGE_RUNTIME = {
    url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
    sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
};

const EYE = {
    base: "https://huggingface.co/desert-ant-labs/eye/resolve/v1.0.0/",
    files: {
        "eye.tflite": "25ba485c959a47961ac9243e74e6ad4997bfc88e1267f62aa88827fc9d92894b",
        "eye_meta.json": null as string | null, // small and text; size-checked only
        "LICENSE.md": "de54a93bae330a39dca2b2dc35b4d8536b3f4a7c3712777e4e10bb6d6754aee7",
    },
};

async function sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    return hash.digest("hex");
}

async function download(url: string, dest: string, expected: string | null): Promise<void> {
    console.log(`↓ ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(dest, res);
    if (expected) {
        const actual = await sha256(dest);
        if (actual !== expected) {
            await rm(dest, { force: true });
            throw new Error(`${url}: checksum mismatch (expected ${expected}, got ${actual})`);
        }
    }
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
}

async function run(cmd: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`${cmd[0]} failed`);
}

// The static release tarball nests the binaries under bin/ (or at the top level, depending on
// the release); search rather than hard-code the layout.
async function findFile(dir: string, name: string): Promise<string | null> {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name);
    }
    return null;
}

async function fetchCjxl(work: string) {
    const out = join(ROOT, "vendor", "jxl");
    if (await exists(join(out, "LICENSE.jpeg-xl"))) return console.log("✓ vendor/jxl/cjxl present");
    const archive = join(work, "jxl.tar.lz");
    await download(LIBJXL.url, archive, LIBJXL.sha256);
    const unpack = join(work, "jxl");
    await mkdir(unpack, { recursive: true });
    await run(["tar", "--lzip", "-xf", archive, "-C", unpack], work);
    await mkdir(out, { recursive: true });
    for (const name of ["cjxl", "djxl"]) {
        const found = await findFile(unpack, name);
        if (!found) throw new Error(`${name} not found in the libjxl release`);
        await copyFile(found, join(out, name));
        await chmod(join(out, name), 0o755);
    }
    // LICENSE.jpeg-xl plus one per statically linked library (brotli, highway, libpng, ...).
    for (const entry of await readdir(unpack)) {
        if (entry.startsWith("LICENSE.")) await copyFile(join(unpack, entry), join(out, entry));
    }
    console.log("✓ vendor/jxl/cjxl, djxl (libjxl 0.12.0)");
}

async function untar(archive: string, dest: string, work: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    await run(["tar", "-xzf", archive, "-C", dest, "--strip-components", "1"], work);
}

async function cmake(args: string[], work: string): Promise<void> {
    await run(["cmake", ...args], work);
}

async function buildCjxlMac(work: string) {
    const out = join(ROOT, "vendor", "jxl");
    if (await exists(join(out, "LICENSE.jpeg-xl"))) return console.log("✓ vendor/jxl/cjxl present");
    if (!Bun.which("cmake")) throw new Error("building cjxl/djxl needs cmake (brew install cmake) and the Xcode command line tools");
    const jobs = String(navigator.hardwareConcurrency);
    const common = ["-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`];

    const jpegSrc = join(work, "libjpeg-turbo");
    const jpegPrefix = join(work, "jpeg");
    await download(LIBJPEG_TURBO.url, join(work, "libjpeg-turbo.tar.gz"), LIBJPEG_TURBO.sha256);
    await untar(join(work, "libjpeg-turbo.tar.gz"), jpegSrc, work);
    await cmake([
        "-S", jpegSrc, "-B", join(jpegSrc, "build"), ...common,
        "-DENABLE_SHARED=OFF", "-DENABLE_STATIC=ON", "-DWITH_TURBOJPEG=OFF", "-DWITH_TOOLS=OFF",
        `-DCMAKE_INSTALL_PREFIX=${jpegPrefix}`, "-DCMAKE_INSTALL_LIBDIR=lib",
    ], work);
    await cmake(["--build", join(jpegSrc, "build"), "--parallel", jobs], work);
    await cmake(["--install", join(jpegSrc, "build")], work);

    const src = join(work, "libjxl");
    await download(LIBJXL_SOURCE.url, join(work, "libjxl.tar.gz"), LIBJXL_SOURCE.sha256);
    await untar(join(work, "libjxl.tar.gz"), src, work);
    for (const [dir, repo, commit, digest] of LIBJXL_SOURCE.thirdParty) {
        const archive = join(work, `${dir}.tar.gz`);
        await download(`https://github.com/${repo}/archive/${commit}.tar.gz`, archive, digest);
        await rm(join(src, "third_party", dir), { recursive: true, force: true });
        await untar(archive, join(src, "third_party", dir), work);
    }
    const build = join(src, "build");
    await cmake([
        "-S", src, "-B", build, ...common,
        "-DBUILD_TESTING=OFF", "-DJPEGXL_STATIC=ON", "-DBUILD_SHARED_LIBS=OFF",
        "-DJPEGXL_BUNDLE_LIBPNG=ON",
        // Only cjxl/djxl; everything else is either unneeded or would look for more system
        // libraries (OpenEXR, giflib, Java).
        "-DJPEGXL_ENABLE_OPENEXR=OFF", "-DJPEGXL_ENABLE_BENCHMARK=OFF", "-DJPEGXL_ENABLE_EXAMPLES=OFF",
        "-DJPEGXL_ENABLE_DOXYGEN=OFF", "-DJPEGXL_ENABLE_MANPAGES=OFF", "-DJPEGXL_ENABLE_JNI=OFF",
        "-DJPEGXL_ENABLE_VIEWERS=OFF", "-DJPEGXL_ENABLE_PLUGINS=OFF", "-DJPEGXL_ENABLE_DEVTOOLS=OFF",
        "-DJPEGXL_ENABLE_FUZZERS=OFF", "-DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON",
        `-DJPEG_INCLUDE_DIR=${join(jpegPrefix, "include")}`,
        `-DJPEG_LIBRARY=${join(jpegPrefix, "lib", "libjpeg.a")}`,
    ], work);
    await cmake(["--build", build, "--parallel", jobs, "--target", "cjxl", "djxl"], work);

    await mkdir(out, { recursive: true });
    for (const name of ["cjxl", "djxl"]) {
        const bin = join(build, "tools", name);
        // A dylib from anywhere but the OS would make the binary depend on this build machine.
        const linked = (await new Response(Bun.spawn(["otool", "-L", bin]).stdout).text())
            .split("\n").slice(1).map((line) => line.trim().split(" ")[0] ?? "").filter(Boolean);
        const foreign = linked.filter((lib) => !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/"));
        if (foreign.length) throw new Error(`${name} links non-system libraries: ${foreign.join(", ")}`);
        await copyFile(bin, join(out, name));
        await chmod(join(out, name), 0o755);
    }
    // LICENSE.jpeg-xl plus one per bundled library, as libjxl's build collects them.
    for (const entry of await readdir(build)) {
        if (entry.startsWith("LICENSE.")) await copyFile(join(build, entry), join(out, entry));
    }
    await copyFile(join(jpegSrc, "LICENSE.md"), join(out, "LICENSE.libjpeg-turbo"));
    await copyFile(join(jpegSrc, "README.ijg"), join(out, "LICENSE.libjpeg-turbo-ijg"));
    console.log("✓ vendor/jxl/cjxl, djxl (libjxl 0.12.0, built from source)");
}

async function fetchAccelerator(work: string) {
    const out = join(ROOT, "vendor", "litert");
    if (await exists(join(out, "LICENSE"))) {
        return console.log("✓ vendor/litert/libLiteRtWebGpuAccelerator.so present");
    }
    const wheel = join(work, "litert.whl");
    await download(LITERT_WHEEL.url, wheel, LITERT_WHEEL.sha256);
    await run(["unzip", "-q", "-o", wheel, LITERT_WHEEL.member, LITERT_WHEEL.license, "-d", work], work);
    await mkdir(out, { recursive: true });
    await copyFile(join(work, LITERT_WHEEL.member), join(out, "libLiteRtWebGpuAccelerator.so"));
    await copyFile(join(work, LITERT_WHEEL.license), join(out, "LICENSE"));
    console.log("✓ vendor/litert/libLiteRtWebGpuAccelerator.so (LiteRT 2.3.0)");
}

async function fetchAppImageRuntime() {
    const dest = join(ROOT, "vendor", "appimage", "runtime-x86_64");
    if (await exists(dest)) return console.log("✓ vendor/appimage/runtime-x86_64 present");
    await mkdir(join(ROOT, "vendor", "appimage"), { recursive: true });
    await download(APPIMAGE_RUNTIME.url, dest, APPIMAGE_RUNTIME.sha256);
    console.log("✓ vendor/appimage/runtime-x86_64 (type2-runtime 20251108)");
}

async function fetchModel() {
    const out = join(ROOT, "models");
    await mkdir(out, { recursive: true });
    for (const [name, digest] of Object.entries(EYE.files)) {
        const dest = join(out, name);
        if (await exists(dest)) {
            if (digest && await sha256(dest) !== digest) throw new Error(`models/${name}: checksum mismatch`);
            console.log(`✓ models/${name} present`);
            continue;
        }
        await download(EYE.base + name, dest, digest);
        console.log(`✓ models/${name}`);
    }
}

const work = await mkdtemp(join(tmpdir(), "cataglyph-vendor-"));
try {
    if (process.platform === "linux") {
        await fetchCjxl(work);
        await fetchAccelerator(work);
    }
    await fetchModel();
    if (process.platform === "linux") await fetchAppImageRuntime();
    if (process.platform === "darwin") await buildCjxlMac(work);
} finally {
    await rm(work, { recursive: true, force: true });
}

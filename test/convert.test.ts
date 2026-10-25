import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { DEFAULT_SETTINGS, ORIGINALS_DIR } from "../src/shared/types.ts";
import type { ConvertSettings, MediaFile } from "../src/shared/types.ts";
import { toolPaths } from "../src/bun/tools.ts";
import { type ConvertJob, outputPathFor, runConvert } from "../src/bun/convert/jxl.ts";
import { readBack } from "../src/bun/convert/exif.ts";
import { rgbaToPpm } from "../src/bun/convert/heic.ts";
import { SELFTEST_JPEG_BASE64, compareVersions } from "../src/bun/convert/selftest.ts";

const settings = (over: Partial<ConvertSettings> = {}): ConvertSettings => ({
    ...DEFAULT_SETTINGS.convert, effort: "1", concurrency: 2, ...over,
});

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "convert-test-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const exists = (p: string) => stat(p).then(() => true, () => false);

async function media(path: string): Promise<MediaFile> {
    const s = await stat(path);
    const name = basename(path);
    return { path, name, ext: name.split(".").pop()!.toLowerCase(), size: s.size, mtimeMs: s.mtimeMs };
}

async function job(path: string, extra: Partial<ConvertJob> = {}): Promise<ConvertJob> {
    return { itemId: basename(path), still: await media(path), motion: null, embeddedMotion: false, hasGainMap: false, ...extra };
}

// A fresh directory per test, with a tagged JPEG fixture.
async function fixture(name: string, tagged = true): Promise<{ dir: string; jpg: string }> {
    const dir = await mkdtemp(join(root, `${name}-`));
    const jpg = join(dir, "photo.jpg");
    await Bun.write(jpg, Buffer.from(SELFTEST_JPEG_BASE64, "base64"));
    if (tagged) {
        const p = Bun.spawn([
            toolPaths().exiftool, "-DateTimeOriginal=2024:05:06 07:08:09", "-Model=TestCam 9",
            "-Artist=Tester", "-overwrite_original", "-q", "-q", jpg,
        ]);
        expect(await p.exited).toBe(0);
    }
    return { dir, jpg };
}

describe("outputPathFor", () => {
    // join: the output sits next to the input with the platform's separator ("\\a\\b" on Windows).
    const still: MediaFile = { path: join("/a", "b", "IMG_1.JPG"), name: "IMG_1.JPG", ext: "jpg", size: 1, mtimeMs: 0 };
    test("suffixes", () => {
        expect(outputPathFor(still, settings())).toBe(join("/a", "b", "IMG_1_lossy_d1.0.jxl"));
        expect(outputPathFor(still, settings({ paramsInName: false }))).toBe(join("/a", "b", "IMG_1_lossy.jxl"));
        expect(outputPathFor(still, settings({ mode: "lossless" }))).toBe(join("/a", "b", "IMG_1_lossless.jxl"));
    });
});

describe("helpers", () => {
    test("compareVersions", () => {
        expect(compareVersions("0.7.0", "0.8.0")).toBe(-1);
        expect(compareVersions("0.12.0", "0.8.0")).toBe(1);
    });
    test("rgbaToPpm drops alpha", () => {
        const ppm = rgbaToPpm(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1);
        const head = "P6\n2 1\n255\n";
        expect(new TextDecoder().decode(ppm.slice(0, head.length))).toBe(head);
        expect([...ppm.slice(head.length)]).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe("runConvert", () => {
    test("lossy ok, exif survives, original deleted", async () => {
        const { jpg } = await fixture("ok");
        const events: number[] = [];
        const summary = await runConvert([await job(jpg)], settings(), (_r, done, total) => events.push(done, total));
        const r = summary.results[0]!;
        expect(r.status).toBe("ok");
        expect(r.output).toBe(join(dirname(jpg), "photo_lossy_d1.0.jxl"));
        expect(await exists(jpg)).toBe(false);
        const back = await readBack(r.output!);
        expect(back.DateTimeOriginal).toBe("2024:05:06 07:08:09");
        expect(back.Model).toBe("TestCam 9");
        expect(summary.ok).toBe(1);
        expect(events).toEqual([1, 1]);
        expect(summary.tools.find(t => t.label === "cjxl")?.version).toMatch(/^\d+\.\d+/);
    });

    test("migrateMetadata copies Artist too", async () => {
        const { jpg } = await fixture("migrate");
        const s = await runConvert([await job(jpg)], settings({ migrateMetadata: true, originals: "move" }), () => {});
        expect(s.ok).toBe(1);
        const p = Bun.spawn([toolPaths().exiftool, "-s3", "-Artist", s.results[0]!.output!], { stdout: "pipe" });
        expect((await new Response(p.stdout).text()).trim()).toBe("Tester");
    });

    test("originals move goes to originals/ and never clobbers", async () => {
        const { dir, jpg } = await fixture("move");
        const s = await runConvert([await job(jpg)], settings({ originals: "move" }), () => {});
        expect(s.ok).toBe(1);
        expect(await exists(join(dir, ORIGINALS_DIR, "photo.jpg"))).toBe(true);
        expect(await exists(jpg)).toBe(false);

        // Second round: same name again, output of the first round removed so it re-encodes.
        await rm(s.results[0]!.output!);
        await Bun.write(jpg, Buffer.from(SELFTEST_JPEG_BASE64, "base64"));
        const s2 = await runConvert([await job(jpg)], settings({ originals: "move" }), () => {});
        expect(s2.ok).toBe(1);
        expect(await exists(jpg)).toBe(true);
        expect(s2.results[0]!.notes.join()).toContain("already exists");
    });

    test("broken input fails and is not deleted; counts add up; existing output skipped", async () => {
        const { dir, jpg } = await fixture("mixed");
        const broken = join(dir, "broken.jpg");
        await Bun.write(broken, "not an image");
        const txt = join(dir, "notes.gif");
        await Bun.write(txt, "GIF89a");
        const jobs = [await job(jpg), await job(broken), await job(txt)];
        const first = await runConvert(jobs, settings({ originals: "delete" }), () => {});
        expect(first.results.length).toBe(3);
        expect(first.ok + first.failed + first.skipped).toBe(3);
        expect(first.ok).toBe(1);
        expect(first.failed).toBe(1);
        expect(first.skipped).toBe(1);
        expect(await exists(broken)).toBe(true);
        expect(await exists(outputPathFor(jobs[1]!.still, settings()))).toBe(false);

        // Re-create the source: the output now exists, so it must be skipped, untouched.
        await Bun.write(jpg, Buffer.from(SELFTEST_JPEG_BASE64, "base64"));
        const out = outputPathFor(jobs[0]!.still, settings());
        const before = (await stat(out)).mtimeMs;
        const second = await runConvert([await job(jpg)], settings(), () => {});
        expect(second.skipped).toBe(1);
        expect(second.results[0]!.message).toBe("output exists");
        expect(await exists(jpg)).toBe(true);
        expect((await stat(out)).mtimeMs).toBe(before);
    });

    test("sidecar motion: discard removes it, extract renames it", async () => {
        for (const motion of ["discard", "extract"] as const) {
            const { dir, jpg } = await fixture(`sidecar-${motion}`);
            const mov = join(dir, "photo.MOV");
            await Bun.write(mov, "fake video");
            const s = await runConvert([await job(jpg, { motion: await media(mov) })], settings({ motion }), () => {});
            expect(s.ok).toBe(1);
            expect(await exists(mov)).toBe(false);
            const files = await readdir(dir);
            if (motion === "extract") expect(files).toContain("photo_lossy_d1.0.MOV");
            else expect(files.some(f => f.endsWith(".MOV"))).toBe(false);
        }
    });

    test("sidecar is kept when the original could not be handled", async () => {
        const { dir, jpg } = await fixture("sidecar-keep");
        const mov = join(dir, "photo.MOV");
        await Bun.write(mov, "fake video");
        await mkdir(join(dir, ORIGINALS_DIR));
        await Bun.write(join(dir, ORIGINALS_DIR, "photo.jpg"), "existing");
        const s = await runConvert([await job(jpg, { motion: await media(mov) })], settings({ originals: "move" }), () => {});
        expect(s.ok).toBe(1);
        expect(await exists(mov)).toBe(true);
        expect(await exists(jpg)).toBe(true);
    });

    test("gain map and embedded motion notes", async () => {
        const { jpg } = await fixture("notes");
        const s = await runConvert([await job(jpg, { hasGainMap: true, embeddedMotion: true })], settings(), () => {});
        expect(s.results[0]!.notes).toContain("HDR gain map not preserved (SDR base only)");
        expect(s.results[0]!.notes).toContain("embedded motion video dropped");
    });

    test("abort skips unstarted jobs but still accounts for them", async () => {
        const { jpg } = await fixture("abort");
        const ac = new AbortController();
        ac.abort();
        const s = await runConvert([await job(jpg)], settings(), () => {}, ac.signal);
        expect(s.skipped).toBe(1);
        expect(await exists(jpg)).toBe(true);
    });
});

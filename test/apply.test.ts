import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { executeApply } from "../src/bun/apply/apply.ts";
import { planApply, summarizePlan } from "../src/bun/apply/plan.ts";
import { moveToTrash } from "../src/bun/apply/trash.ts";
import type { Decision, Item, MediaFile } from "../src/shared/types.ts";

let dir: string;
let trashDir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apply-test-"));
    trashDir = await mkdtemp(join(tmpdir(), "apply-trash-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(trashDir, { recursive: true, force: true });
});

async function file(name: string, content = "xxxx"): Promise<MediaFile> {
    const path = join(dir, name);
    await writeFile(path, content);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return { path, name, ext, size: content.length, mtimeMs: 0 };
}

async function photo(id: string, withRaw = true): Promise<Item> {
    const stem = id.replace(/\.JPG$/, "");
    return {
        id,
        kind: "photo",
        primary: await file(id),
        raw: withRaw ? await file(`${stem}.ARW`, "rawdata") : null,
        primarySidecars: [],
        rawSidecars: withRaw ? [await file(`${stem}.ARW.pp3`, "pp")] : [],
        originals: [],
        motion: null,
        embeddedMotion: false,
        hasGainMap: false,
        captureTime: null,
        width: 0,
        height: 0,
        contentKey: id,
    };
}

const dec = (verdict: "keep" | "delete", keepRaw = false): Decision => ({ verdict, source: "manual", keepRaw });
const opts = { folder: "", deleteMode: "trash" as const };

describe("planApply", () => {
    test("delete item trashes every file", async () => {
        const item = await photo("A.JPG");
        item.motion = await file("A.MOV");
        item.primarySidecars = [await file("A.JPG.xmp")];
        const actions = planApply([item], { "A.JPG": dec("delete") }, { ...opts, folder: dir });
        expect(actions.map((a) => basename(a.from))).toEqual(["A.JPG", "A.JPG.xmp", "A.ARW", "A.ARW.pp3", "A.MOV"]);
        expect(actions.every((a) => a.kind === "trash" && a.why === "deleted item")).toBe(true);
        const s = summarizePlan(actions);
        expect(s.trash).toBe(5);
        expect(s.bytesFreed).toBe(4 + 4 + 7 + 2 + 4);
    });

    test("archived item: delete takes the originals along, keep leaves them", async () => {
        const item = await photo("G_lossy_d1.0.jxl");
        item.kind = "archived";
        item.raw = await file("G.ARW", "rawdata");
        item.rawSidecars = [await file("G.ARW.pp3", "pp")];
        item.originals = [await file("G.JPG")];
        const deleted = planApply([item], { [item.id]: dec("delete") }, { ...opts, folder: dir });
        expect(deleted.map((a) => basename(a.from))).toEqual(["G_lossy_d1.0.jxl", "G.JPG", "G.ARW", "G.ARW.pp3"]);
        const kept = planApply([item], { [item.id]: dec("keep", true) }, { ...opts, folder: dir });
        expect(kept.map((a) => [a.kind, basename(a.from)])).toEqual([["move", "G.ARW"], ["move", "G.ARW.pp3"]]);
    });

    test("keep + keepRaw moves raw and sidecar into RAW/", async () => {
        const item = await photo("B.JPG");
        const actions = planApply([item], { "B.JPG": dec("keep", true) }, { ...opts, folder: dir });
        expect(actions.map((a) => [a.kind, a.to])).toEqual([
            ["move", join(dir, "RAW", "B.ARW")],
            ["move", join(dir, "RAW", "B.ARW.pp3")],
        ]);
    });

    test("keep without keepRaw trashes raw side only", async () => {
        const item = await photo("C.JPG");
        const actions = planApply([item], { "C.JPG": dec("keep") }, { ...opts, folder: dir });
        expect(actions.map((a) => basename(a.from))).toEqual(["C.ARW", "C.ARW.pp3"]);
        expect(actions.every((a) => a.why === "RAW not kept")).toBe(true);
    });

    test("no decision and keep-without-raw give nothing", async () => {
        const item = await photo("D.JPG");
        const plain = await photo("E.JPG", false);
        expect(planApply([item], {}, { ...opts, folder: dir })).toEqual([]);
        expect(planApply([plain], { "E.JPG": dec("keep", true) }, { ...opts, folder: dir })).toEqual([]);
    });

    test("permanent mode uses unlink", async () => {
        const item = await photo("F.JPG");
        const actions = planApply([item], { "F.JPG": dec("delete") }, { folder: dir, deleteMode: "permanent" });
        expect(actions.every((a) => a.kind === "unlink")).toBe(true);
    });
});

describe("executeApply", () => {
    test("moves into RAW/, unlinks, reports progress", async () => {
        const keep = await photo("G.JPG");
        const del = await photo("H.JPG");
        const actions = planApply(
            [keep, del],
            { "G.JPG": dec("keep", true), "H.JPG": dec("delete") },
            { folder: dir, deleteMode: "permanent" },
        );
        let calls = 0;
        const summary = await executeApply(actions, () => calls++);
        expect(summary.moved).toBe(2);
        expect(summary.unlinked).toBe(3);
        expect(summary.failed).toBe(0);
        expect(summary.bytesFreed).toBe(4 + 7 + 2);
        expect(calls).toBe(5);
        expect(existsSync(join(dir, "RAW", "G.ARW.pp3"))).toBe(true);
        expect(existsSync(join(dir, "G.JPG"))).toBe(true);
        expect(existsSync(join(dir, "H.JPG"))).toBe(false);
    });

    test("move collision is not clobbered", async () => {
        const item = await photo("I.JPG");
        await mkdir(join(dir, "RAW"));
        await writeFile(join(dir, "RAW", "I.ARW"), "old");
        const actions = planApply([item], { "I.JPG": dec("keep", true) }, { ...opts, folder: dir });
        const summary = await executeApply(actions);
        expect(summary.failed).toBe(1);
        expect(summary.moved).toBe(1);
        expect(await readFile(join(dir, "RAW", "I.ARW"), "utf8")).toBe("old");
        expect(existsSync(join(dir, "I.ARW"))).toBe(true);
    });

    test("missing file is reported, others continue", async () => {
        const item = await photo("J.JPG");
        await rm(item.primary.path);
        const actions = planApply([item], { "J.JPG": dec("delete") }, { folder: dir, deleteMode: "permanent" });
        const summary = await executeApply(actions);
        expect(summary.failed).toBe(1);
        expect(summary.outcomes.find((o) => !o.ok)?.error).toBe("missing");
        expect(summary.unlinked).toBe(2);
    });

    test("trash via spec backend", async () => {
        const item = await photo("K.JPG");
        const actions = planApply([item], { "K.JPG": dec("keep") }, { ...opts, folder: dir });
        const summary = await executeApply(actions, undefined, { backend: "spec", trashDir });
        expect(summary.trashed).toBe(2);
        expect(summary.bytesFreed).toBe(9);
        expect(existsSync(item.raw?.path ?? "")).toBe(false);
        expect(existsSync(item.primary.path)).toBe(true);
    });
});

// The freedesktop trash (Path= is a URL-encoded absolute POSIX path); Windows trashes through
// Electron's shell.trashItem and never uses this backend.
describe.skipIf(process.platform === "win32")("spec trash backend", () => {
    test("writes files/ and info/*.trashinfo, unique names on collision", async () => {
        const a = await file("same name.jpg", "one");
        const results1 = await moveToTrash([a.path], { backend: "spec", trashDir });
        const b = await file("same name.jpg", "two");
        const results2 = await moveToTrash([b.path], { backend: "spec", trashDir });
        expect(results1[0]?.ok).toBe(true);
        expect(results2[0]?.ok).toBe(true);
        expect((await readdir(join(trashDir, "files"))).sort()).toEqual(["same name.jpg", "same name.jpg.2"]);
        const info = await readFile(join(trashDir, "info", "same name.jpg.trashinfo"), "utf8");
        expect(info).toContain("[Trash Info]");
        expect(info).toContain(`Path=${dir}/same%20name.jpg`);
        expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
        expect(await readFile(join(trashDir, "files", "same name.jpg.2"), "utf8")).toBe("two");
    });

    test("missing file reports an error", async () => {
        const [r] = await moveToTrash([join(dir, "nope.jpg")], { backend: "spec", trashDir });
        expect(r?.ok).toBe(false);
        expect(r?.error).toBeTruthy();
    });
});

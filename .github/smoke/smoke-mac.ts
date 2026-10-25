// Scratch-repo only: launch the packaged Cataglyph.app, open a folder, run Eye, screenshot.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";

const app = Bun.argv[2]!;
const dir = await mkdtemp(join(tmpdir(), "smoke-"));
for (let n = 0; n < 4; n++) {
    const width = 800, height = 600;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = (x * (n + 1)) & 255; data[i + 1] = (y * (n + 2)) & 255; data[i + 2] = ((x ^ y) * n) & 255; data[i + 3] = 255;
    }
    await Bun.write(join(dir, `IMG_000${n}.jpg`), jpeg.encode({ data, width, height }, 90).data);
}

const executable = app.endsWith(".app") ? join(app, "Contents/MacOS/Cataglyph") : app;
const proc = Bun.spawn([executable, "--remote-debugging-port=9222"], { stdout: "inherit", stderr: "inherit" });
let target: { type: string; webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 60 && !target; i++) {
    await Bun.sleep(1000);
    try {
        const list = await (await fetch("http://127.0.0.1:9222/json")).json() as typeof target[];
        target = list.find(t => t?.type === "page");
    } catch {}
}
if (!target) throw new Error("no CDP page target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener("message", ev => {
    const msg = JSON.parse(String(ev.data));
    pending.get(msg.id)?.(msg);
});
function cdp(method: string, params: object = {}): Promise<any> {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(r => pending.set(id, r));
}
async function evaluate(expression: string): Promise<any> {
    const res = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
}

for (let i = 0; i < 30 && !await evaluate("!!window.__ingest?.state.init.value"); i++) await Bun.sleep(1000);
console.log("init", JSON.stringify(await evaluate("JSON.stringify(__ingest.state.init.value)")));
await Bun.write("smoke-start.png", Buffer.from((await cdp("Page.captureScreenshot")).result.data, "base64"));
await evaluate(`__ingest.state.openFolder(${JSON.stringify(dir)})`);
console.log("error", await evaluate("__ingest.state.error.value"));
const total = await evaluate("__ingest.state.items.value.length");
console.log("items", total);
console.log("startAnalysis", JSON.stringify(await evaluate("__ingest.state.rpc.startAnalysis({}).then(r => JSON.stringify(r), e => 'ERR ' + e.message)")));
let done = 0;
for (let i = 0; i < 90; i++) {
    await Bun.sleep(2000);
    done = await evaluate("Object.keys(__ingest.state.analyses.value).length");
    if (i % 5 === 0 || done >= total) console.log("analyses", done, "/", total, "eye", await evaluate("JSON.stringify(__ingest.state.eye.value)"));
    if (done >= total) break;
}
await Bun.sleep(2000);
await Bun.write("smoke-gallery.png", Buffer.from((await cdp("Page.captureScreenshot")).result.data, "base64"));
console.log(Bun.spawnSync(process.platform === "win32" ? ["tasklist"] : ["ps", "-ax", "-o", "pid,ppid,command"]).stdout.toString().split("\n").filter(l => /Cataglyph|bun/i.test(l)).join("\n"));
proc.kill();
if (!total || done < total) process.exit(1);

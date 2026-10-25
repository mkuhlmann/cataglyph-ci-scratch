// Main-process side of the Eye inference process: spawns it, picks GPU or CPU, and turns the
// IPC messages into promises.
//
// GPU first, CPU as the fallback. The GPU path is LiteRT's WebGPU accelerator (Dawn on
// Vulkan/RADV here) loaded from vendor/litert via LD_LIBRARY_PATH. If that process fails to
// load the model or dies, the client respawns without the accelerator on the library path,
// which leaves LiteRT on its XNNPACK CPU backend - slower (~280 vs ~115 ms per photo on a
// Radeon 890M) but always available.
//
// Windows has no LD_LIBRARY_PATH: LoadLibrary looks for a DLL's dependencies on PATH, not
// next to the DLL koffi loaded by full path. Eye's native core there is our own build
// (EyeNode.dll, see scripts/fetch-vendor.ts) next to libLiteRt.dll and the Swift runtime DLLs,
// so that directory goes on PATH for every Eye process, and the accelerator's for the GPU one.

import { delimiter } from "node:path";

import type { Subprocess } from "bun";

import type { AnalysisSummary } from "../../shared/types.ts";
import { toolPaths } from "../tools.ts";
import type { EyeRequest, EyeResponse } from "./eye-protocol.ts";

export interface EyeStatus {
    accelerator: "gpu" | "cpu";
    /** "AMD Radeon 890M Graphics (RADV GFX1150), backend=Vulkan" when LiteRT reports one. */
    adapter: string | null;
}

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void };

export class EyeClient {
    private proc: Subprocess | null = null;
    private pending = new Map<string, Pending>();
    private seq = 0;
    private adapter: string | null = null;
    status: EyeStatus | null = null;

    /**
     * @param entry Script that runs eye-process.ts under CATAGLYPH_ROLE=eye. The app's own
     * bundle (Bun.main) by default; tests point it at src/bun/index.ts.
     */
    constructor(private entry: string = Bun.main) {}

    async start(useGpu: boolean): Promise<EyeStatus> {
        const tools = toolPaths();
        if (!tools.modelDir) throw new Error("Eye model not found (models/eye.tflite). Run `bun run vendor`.");

        if (useGpu && tools.litertAcceleratorDir) {
            try {
                return await this.spawn(true, tools.modelDir, tools.litertAcceleratorDir);
            } catch (err) {
                console.warn(`[eye] GPU start failed, falling back to CPU: ${(err as Error).message}`);
                this.kill();
            }
        }
        return await this.spawn(false, tools.modelDir, null);
    }

    private spawn(gpu: boolean, modelDir: string, acceleratorDir: string | null): Promise<EyeStatus> {
        const env: Record<string, string | undefined> = { ...process.env, CATAGLYPH_ROLE: "eye" };
        const prepend = (name: string, dir: string) => {
            env[name] = env[name] ? `${dir}${delimiter}${env[name]}` : dir;
        };
        const windows = process.platform === "win32";
        const eyeNative = toolPaths().eyeNativeDir;
        if (windows && eyeNative) prepend(pathVar(env), eyeNative);
        if (gpu && acceleratorDir) {
            prepend(windows ? pathVar(env) : "LD_LIBRARY_PATH", acceleratorDir);
            env.CATAGLYPH_EYE_GPU = "1";
        } else {
            env.CATAGLYPH_EYE_GPU = "0";
        }
        this.adapter = null;

        return new Promise<EyeStatus>((resolve, reject) => {
            let ready = false;
            const proc = Bun.spawn([process.execPath, this.entry], {
                env,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "pipe",
                ipc: (msg: EyeResponse) => {
                    if (msg.type === "ready") {
                        ready = true;
                        // LiteRT registers the accelerator but compiles kernels lazily, so
                        // "ready" on the GPU path only means the library loaded. The adapter
                        // line in stderr is the proof the GPU is really in use.
                        this.status = {
                            accelerator: msg.accelerator,
                            adapter: msg.accelerator === "gpu" ? this.adapter : null,
                        };
                        resolve(this.status);
                        return;
                    }
                    if (msg.type === "fatal") {
                        reject(new Error(msg.message));
                        return;
                    }
                    this.onMessage(msg);
                },
                onExit: (_p, code, signal) => {
                    const err = new Error(`Eye process exited (${signal ?? code})`);
                    if (!ready) reject(err);
                    for (const p of this.pending.values()) p.reject(err);
                    this.pending.clear();
                    if (this.proc === proc) this.proc = null;
                },
            });
            this.proc = proc;
            void this.watchStderr(proc);
            this.send({ type: "init", modelDir });
        });
    }

    // LiteRT logs to stderr; mine it for the adapter name and forward the rest at debug level.
    private async watchStderr(proc: Subprocess) {
        if (!proc.stderr || typeof proc.stderr === "number") return;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const m = /Selected adapter: (.*?), arch=.*?backend=(\w+)/.exec(line);
                if (m) {
                    this.adapter = `${m[1]}, ${m[2]}`;
                    if (this.status?.accelerator === "gpu") this.status.adapter = this.adapter;
                }
                if (process.env.CATAGLYPH_DEBUG) console.log(`[eye] ${line}`);
            }
        }
    }

    private send(msg: EyeRequest) {
        this.proc?.send(msg);
    }

    private onMessage(msg: EyeResponse) {
        if (msg.type === "ready" || msg.type === "fatal") return;
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.type === "error") pending.reject(new Error(msg.message));
        else if (msg.type === "result") pending.resolve({ summary: msg.summary, json: msg.json });
        else if (msg.type === "groups") pending.resolve({ groups: msg.groups, best: msg.best });
    }

    private request<T>(build: (id: string) => EyeRequest): Promise<T> {
        if (!this.proc) return Promise.reject(new Error("Eye process is not running"));
        const id = String(++this.seq);
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send(build(id));
        });
    }

    /** Analyze one image file (JPEG/PNG/WebP that Bun.Image can read). */
    analyze(path: string): Promise<{ summary: AnalysisSummary; json: string }> {
        return this.request(id => ({ type: "analyze", id, path }));
    }

    /** Near-duplicate groups (indices into `analyses`, best first) and each group's keeper. */
    group(analyses: string[], dates: (number | null)[]): Promise<{ groups: number[][]; best: number[] }> {
        return this.request(id => ({ type: "group", id, analyses, dates }));
    }

    get running(): boolean {
        return this.proc !== null;
    }

    kill() {
        this.proc?.kill();
        this.proc = null;
    }

    async stop() {
        if (!this.proc) return;
        this.send({ type: "shutdown" });
        const proc = this.proc;
        await Promise.race([proc.exited, Bun.sleep(2000)]);
        proc.kill();
        this.proc = null;
    }
}

// Windows environment names are case-insensitive, and the inherited one is usually "Path".
// Spread into a plain object it stays "Path", and a new "PATH" next to it would be a second
// variable the child resolves unpredictably.
function pathVar(env: Record<string, string | undefined>): string {
    return Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
}

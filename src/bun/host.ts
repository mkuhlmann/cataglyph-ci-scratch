// The Bun process's end of the IPC channel to the Electron main process.
//
// Electron starts this process with a Node IPC channel (src/electron/sidecar.ts), and Bun
// speaks that protocol as `process.send` / `process.on("message")` with JSON serialization.
// Over it run three kinds of traffic (WireMessage in shared/rpc.ts): the view's requests
// (relayed by the main process), messages pushed to the view, and this process's calls into
// the main process for what only Electron can do: native dialogs, the shell and the trash.

import type { CataglyphRPC, HostRequests, Outcome, RequestHandlers, WireMessage } from "../shared/rpc.ts";

type ViewMessages = CataglyphRPC["webview"]["messages"];

const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
let seq = 0;
let handlers: RequestHandlers | null = null;
// The view asks for `init` as soon as it loads, and the main process relays it while app.ts is
// still in its top-level awaits (settings, store, Eye client) before serve(). On Linux that
// race was always won; the packaged Windows build lost it on every start (a slower process
// start), and the view showed "unknown request init" over an empty window. Requests wait here.
let served!: () => void;
const ready = new Promise<void>(resolve => served = resolve);
let shutdown: (() => Promise<void>) | null = null;
let stopping = false;

function post(msg: WireMessage) {
    process.send?.(msg);
}

async function answer(id: number, method: string, params: unknown) {
    let outcome: Outcome;
    await ready;
    try {
        const handler = handlers?.[method as keyof RequestHandlers] as ((p: unknown) => unknown) | undefined;
        if (!handler) throw new Error(`unknown request ${method}`);
        outcome = { result: await handler(params) };
    } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    post({ type: "response", id, outcome });
}

// Both "shutdown" and the disconnect that follows it when the main process exits end up
// here; only the first one cleans up.
async function stop() {
    if (stopping) return;
    stopping = true;
    await shutdown?.();
    process.exit(0);
}

process.on("message", (msg: WireMessage) => {
    switch (msg.type) {
        case "request":
            void answer(msg.id, msg.method, msg.params);
            return;
        case "hostResponse": {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if ("error" in msg.outcome) p.reject(new Error(msg.outcome.error));
            else p.resolve(msg.outcome.result);
            return;
        }
        case "shutdown":
            void stop();
            return;
    }
});

// The main process died without saying goodbye (crash, SIGKILL): nobody is left to show
// anything, so clean up the children (Eye, exiftool) and go.
process.on("disconnect", () => void stop());

/** Starts answering the view's requests. `onShutdown` runs before the process exits. */
export function serve(requestHandlers: RequestHandlers, onShutdown: () => Promise<void>) {
    handlers = requestHandlers;
    shutdown = onShutdown;
    served();
}

/** Pushes a message to the view. */
export function send<K extends keyof ViewMessages>(name: K, payload: ViewMessages[K]) {
    post({ type: "message", name, payload });
}

/** Calls a service of the Electron main process. */
export function host<K extends keyof HostRequests>(method: K, params: HostRequests[K]["params"]): Promise<HostRequests[K]["response"]> {
    if (!process.send) return Promise.reject(new Error("not started by the Electron main process"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ type: "host", id, method, params });
    });
}

<script setup lang="ts" vapor>
import { computed, onMounted, ref } from "vue";

import type { ConvertPreview } from "../../shared/rpc.ts";
import { DEFAULT_SETTINGS, type ConvertSettings, type ConvertSummary } from "../../shared/types.ts";
import { formatBytes, t } from "../i18n/index.ts";
import { convertProgress, folder, openFolder, rpc, settings } from "../state.ts";

const emit = defineEmits<{ close: [] }>();

const form = ref<ConvertSettings>({ ...(settings.value?.convert ?? DEFAULT_SETTINGS.convert) });
const preview = ref<ConvertPreview | null>(null);
const loadError = ref<string | null>(null);
const running = ref(false);
const cancelling = ref(false);
const summary = ref<ConvertSummary | null>(null);
const runError = ref<string | null>(null);

const lossy = computed(() => form.value.mode === "lossy");
const pct = computed(() => (convertProgress.value && convertProgress.value.total ? (convertProgress.value.done / convertProgress.value.total) * 100 : 0));
const results = computed(() => convertProgress.value?.results ?? []);
const liveIn = computed(() => results.value.reduce((n, r) => n + (r.status === "ok" ? r.inputBytes : 0), 0));
const liveOut = computed(() => results.value.reduce((n, r) => n + (r.status === "ok" ? r.outputBytes : 0), 0));
const example = computed(() => {
    const f = form.value;
    if (!f.paramsInName) return "DSC00153.jxl";
    const d = Number.parseFloat(f.distance);
    const dist = Number.isFinite(d) ? d.toFixed(1) : "1.0";
    return f.mode === "lossless" ? "DSC00153_lossless.jxl" : `DSC00153_lossy_d${dist}.jxl`;
});

function base(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}
function saved(before: number, after: number): string {
    return before > 0 ? `${Math.round((1 - after / before) * 100)} %` : "–";
}
function icon(status: string): string {
    return status === "ok" ? "✓" : status === "failed" ? "✕" : "–";
}
function normaliseDistance() {
    const d = Number.parseFloat(form.value.distance);
    form.value.distance = (Number.isFinite(d) ? Math.min(25, Math.max(0, d)) : 1).toFixed(1);
}

onMounted(async () => {
    try {
        preview.value = await rpc.previewConvert({});
    } catch (err) {
        loadError.value = (err as Error).message;
    }
});

async function start() {
    if (running.value || !preview.value) return;
    normaliseDistance();
    const local: ConvertSettings = { ...form.value, concurrency: Math.min(24, Math.max(1, Math.round(Number(form.value.concurrency)) || 1)) };
    settings.value = { ...settings.value!, convert: local };
    running.value = true;
    cancelling.value = false;
    runError.value = null;
    convertProgress.value = null;
    try {
        summary.value = await rpc.runConvert({ settings: local });
    } catch (err) {
        runError.value = (err as Error).message;
    } finally {
        running.value = false;
    }
}

async function cancelRun() {
    cancelling.value = true;
    await rpc.cancelConvert({});
}

async function finish() {
    await openFolder(folder.value);
    emit("close");
}

// After a run the folder has changed on disk, so every way out rescans it; otherwise the
// gallery kept showing the deleted or converted files with their stale thumbnails.
function close() {
    if (running.value) return;
    if (summary.value || runError.value) void finish();
    else emit("close");
}
</script>

<template>
    <div class="overlay" @click.self="close">
        <div class="dialog wide">
            <h2>{{ t("convert.title") }}</h2>

            <p v-if="runError" class="errbox">{{ runError }}</p>

            <!-- summary -->
            <template v-if="summary">
                <div class="stats">
                    <div><b class="ok">{{ summary.ok }}</b><span class="muted">{{ t("convert.stat.ok") }}</span></div>
                    <div><b :class="{ bad: summary.failed > 0 }">{{ summary.failed }}</b><span class="muted">{{ t("convert.stat.failed") }}</span></div>
                    <div><b>{{ summary.skipped }}</b><span class="muted">{{ t("convert.stat.skipped") }}</span></div>
                </div>
                <p>
                    {{ formatBytes(summary.inputBytes) }} → {{ formatBytes(summary.outputBytes) }}
                    <b>({{ t("convert.saved", { pct: saved(summary.inputBytes, summary.outputBytes) }) }})</b>
                </p>
                <div class="tools mono muted">
                    <div v-for="tool in summary.tools" :key="tool.label">{{ tool.label }} {{ tool.version }}</div>
                </div>
                <div v-if="summary.failed" class="log mono">
                    <div v-for="r in summary.results.filter(r => r.status === 'failed')" :key="r.itemId">
                        <span class="bad">✕</span> {{ base(r.input) }} <span class="muted">{{ r.message }}</span>
                    </div>
                </div>
                <div class="actions"><button class="primary" @click="finish">{{ t("convert.finish") }}</button></div>
            </template>

            <!-- running -->
            <template v-else-if="running">
                <p>
                    {{ convertProgress?.done ?? 0 }} / {{ convertProgress?.total ?? preview?.count ?? 0 }}
                    <span class="muted mono">{{ formatBytes(liveIn) }} → {{ formatBytes(liveOut) }} ({{ saved(liveIn, liveOut) }})</span>
                </p>
                <div class="progress"><div :style="{ width: pct + '%' }" /></div>
                <div class="log mono">
                    <div v-for="r in [...results].reverse()" :key="r.itemId + r.input">
                        <span :class="r.status">{{ icon(r.status) }}</span>
                        {{ base(r.input) }}
                        <span v-if="r.status === 'ok'" class="muted">
                            {{ formatBytes(r.inputBytes) }} → {{ formatBytes(r.outputBytes) }} ({{ saved(r.inputBytes, r.outputBytes) }})
                        </span>
                        <span v-if="r.message || r.notes.length" class="muted">{{ [r.message, ...r.notes].filter(Boolean).join("; ") }}</span>
                    </div>
                </div>
                <div class="actions">
                    <button :disabled="cancelling" @click="cancelRun">{{ cancelling ? t("convert.cancelling") : t("convert.cancel") }}</button>
                </div>
            </template>

            <!-- form -->
            <template v-else>
                <p v-if="loadError" class="errbox">{{ loadError }}</p>
                <p v-else-if="!preview" class="muted">{{ t("convert.computing") }}</p>
                <template v-else>
                    <p>
                        {{ t("convert.summary", { count: preview.count, size: formatBytes(preview.bytes) }) }}
                    </p>
                    <p v-if="preview.gainMaps > 0" class="note">
                        {{ t("convert.gainMaps", { count: preview.gainMaps }) }}
                    </p>
                    <p v-if="preview.motion > 0" class="note">
                        {{ t("convert.motion", { count: preview.motion }) }}
                    </p>
                    <details v-if="preview.skipped.length">
                        <summary>{{ t("convert.skippedSummary", { count: preview.skipped.length }) }}</summary>
                        <div class="log mono">
                            <div v-for="s in preview.skipped" :key="s.id"><span class="muted">{{ t("convert.skippedItem", { id: s.id, ext: s.ext }) }}</span></div>
                        </div>
                    </details>
                </template>

                <div class="form">
                    <label class="row">
                        <span>{{ t("convert.mode") }}</span>
                        <select v-model="form.mode">
                            <option value="lossy">{{ t("convert.mode.lossy") }}</option>
                            <option value="lossless">{{ t("convert.mode.lossless") }}</option>
                        </select>
                    </label>
                    <label v-if="lossy" class="row">
                        <span>{{ t("convert.distance") }}</span>
                        <input v-model="form.distance" type="number" step="0.1" min="0" max="25" @change="normaliseDistance" />
                    </label>
                    <label class="row">
                        <span>{{ t("convert.effort") }}</span>
                        <select v-model="form.effort">
                            <option v-for="n in 9" :key="n" :value="String(n)">{{ n }}</option>
                        </select>
                    </label>
                    <div class="row">
                        <span />
                        <label class="check">
                            <input v-model="form.paramsInName" type="checkbox" />
                            {{ t("convert.paramsInName") }} <span class="mono muted">{{ example }}</span>
                        </label>
                    </div>
                    <div class="row">
                        <span>{{ t("convert.originals") }}</span>
                        <div class="radios">
                            <label><input v-model="form.originals" type="radio" value="delete" /> {{ t("convert.originals.delete") }}</label>
                            <label><input v-model="form.originals" type="radio" value="move" /> {{ t("convert.originals.move") }}</label>
                        </div>
                    </div>
                    <div class="row">
                        <span>{{ t("convert.motionVideo") }}</span>
                        <div class="radios">
                            <label><input v-model="form.motion" type="radio" value="discard" /> {{ t("convert.motion.discard") }}</label>
                            <label><input v-model="form.motion" type="radio" value="extract" /> {{ t("convert.motion.extract") }}</label>
                        </div>
                    </div>
                    <div class="row">
                        <span />
                        <label class="check">
                            <input v-model="form.migrateMetadata" type="checkbox" />
                            {{ t("convert.migrateMetadata") }}
                        </label>
                    </div>
                    <label class="row">
                        <span>{{ t("convert.concurrency") }}</span>
                        <input v-model.number="form.concurrency" type="number" min="1" max="24" step="1" />
                    </label>
                </div>
                <p class="muted small">
                    {{ t("convert.safety") }}
                </p>

                <div class="actions">
                    <button @click="close">{{ t("convert.cancel") }}</button>
                    <button class="primary" :disabled="!preview || preview.count === 0" @click="start">
                        {{ t("convert.start", { count: preview?.count ?? 0 }) }}
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.wide { width: min(720px, 94vw); }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 10px; }
.stats > div { background: var(--bg-3); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.stats b { font-size: 18px; }
.ok { color: var(--keep); }
.bad, .failed { color: var(--delete); }
.skipped { color: var(--muted); }
.errbox { background: rgba(255, 93, 93, 0.12); border: 1px solid var(--delete); color: var(--delete); border-radius: 6px; padding: 10px 12px; font-weight: 600; }
.note { color: var(--warn); margin: 4px 0; }
.small { font-size: 12.5px; }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0 10px; }
.row { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 12px; }
.row input[type="number"], .row select { width: 220px; }
.radios { display: flex; flex-direction: column; gap: 4px; }
.radios label, .check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.log { max-height: 220px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
.tools { margin-bottom: 8px; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--muted); }
</style>

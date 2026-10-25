<script setup lang="ts" vapor>
import { computed, onMounted, ref, watch } from "vue";

import type { ApplyPreview } from "../../shared/rpc.ts";
import type { ApplySummary } from "../../shared/types.ts";
import type { MessageKey } from "../i18n/en.ts";
import { formatBytes, t } from "../i18n/index.ts";
import { applyProgress, folder, openFolder, rpc, settings } from "../state.ts";

const emit = defineEmits<{ close: [] }>();

const permanent = ref(settings.value?.deleteMode === "permanent");
const preview = ref<ApplyPreview | null>(null);
const loadError = ref<string | null>(null);
const running = ref(false);
const summary = ref<ApplySummary | null>(null);
const runError = ref<string | null>(null);

const mode = computed(() => (permanent.value ? "permanent" : "trash"));
const failures = computed(() => summary.value?.outcomes.filter(o => !o.ok) ?? []);
const pct = computed(() => (applyProgress.value && applyProgress.value.total ? (applyProgress.value.done / applyProgress.value.total) * 100 : 0));

const WHY_KEYS: Record<string, MessageKey> = {
    "deleted item": "apply.why.deleted",
    "RAW not kept": "apply.why.rawNotKept",
    "keep RAW": "apply.why.keepRaw",
};
const why = (raw: string) => (WHY_KEYS[raw] ? t(WHY_KEYS[raw]) : raw);

function base(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

let token = 0;
async function load() {
    const mine = ++token;
    loadError.value = null;
    try {
        const p = await rpc.previewApply({ deleteMode: mode.value });
        if (mine === token) preview.value = p;
    } catch (err) {
        if (mine === token) loadError.value = (err as Error).message;
    }
}

onMounted(load);
watch(permanent, load);

async function run() {
    if (running.value || !preview.value) return;
    running.value = true;
    runError.value = null;
    applyProgress.value = null;
    try {
        summary.value = await rpc.runApply({ deleteMode: mode.value });
    } catch (err) {
        runError.value = (err as Error).message;
    } finally {
        running.value = false;
    }
}

async function finish() {
    await openFolder(folder.value);
    emit("close");
}

// After a run the folder has changed on disk, so every way out rescans it; otherwise the
// gallery kept showing the deleted files with their stale thumbnails.
function cancel() {
    if (running.value) return;
    if (summary.value || runError.value) void finish();
    else emit("close");
}
</script>

<template>
    <div class="overlay" @click.self="cancel">
        <div class="dialog">
            <h2>{{ t("apply.title") }}</h2>

            <!-- result -->
            <template v-if="summary">
                <div class="stats">
                    <div><b>{{ summary.trashed }}</b><span class="muted">{{ t("apply.done.trashed") }}</span></div>
                    <div><b>{{ summary.unlinked }}</b><span class="muted">{{ t("apply.done.unlinked") }}</span></div>
                    <div><b>{{ summary.moved }}</b><span class="muted">{{ t("apply.done.moved") }}</span></div>
                    <div :class="{ bad: summary.failed > 0 }"><b>{{ summary.failed }}</b><span class="muted">{{ t("apply.done.failed") }}</span></div>
                </div>
                <p>{{ t("apply.freed", { size: formatBytes(summary.bytesFreed) }) }}</p>
                <div v-if="failures.length" class="failures mono">
                    <div v-for="(o, i) in failures" :key="i">
                        <span class="bad">✕</span> {{ base(o.action.from) }} <span class="muted">{{ o.error }}</span>
                    </div>
                </div>
                <div class="actions">
                    <button class="primary" @click="finish">{{ t("apply.finish") }}</button>
                </div>
            </template>

            <!-- running -->
            <template v-else-if="running">
                <p>
                    {{ permanent ? t("apply.running.permanent") : t("apply.running.trash") }}
                    <span v-if="applyProgress" class="muted mono">{{ applyProgress.done }}/{{ applyProgress.total }}</span>
                </p>
                <div class="progress"><div :style="{ width: pct + '%' }" /></div>
            </template>

            <!-- preview -->
            <template v-else>
                <p v-if="loadError" class="bad">{{ loadError }}</p>
                <p v-else-if="!preview" class="muted">{{ t("apply.computing") }}</p>
                <template v-else>
                    <div class="stats">
                        <div><b>{{ preview.itemsDeleted }}</b><span class="muted">{{ t("apply.stat.items") }}</span></div>
                        <div><b>{{ preview.rawsDeleted }}</b><span class="muted">{{ t("apply.stat.rawsDeleted") }}</span></div>
                        <div><b>{{ preview.rawsKept }}</b><span class="muted">{{ t("apply.stat.rawsKept") }}</span></div>
                        <div><b>{{ formatBytes(preview.bytesFreed) }}</b><span class="muted">{{ t("apply.stat.freed") }}</span></div>
                    </div>
                    <p class="muted counts">
                        {{ t("apply.counts", { trash: preview.trash, unlink: preview.unlink, move: preview.move }) }}
                    </p>

                    <label class="check">
                        <input v-model="permanent" type="checkbox" />
                        {{ t("apply.permanent") }}
                    </label>
                    <p v-if="permanent" class="warn">{{ t("apply.irreversible") }}</p>

                    <details v-if="preview.actions.length">
                        <summary>{{ t("apply.allActions", { count: preview.actions.length }) }}</summary>
                        <div class="table">
                            <table class="mono">
                                <tbody>
                                    <tr v-for="(a, i) in preview.actions" :key="i">
                                        <td :class="'k-' + a.kind">{{ t(`apply.kind.${a.kind}`) }}</td>
                                        <td class="name">{{ base(a.from) }}</td>
                                        <td class="muted">{{ why(a.why) }}</td>
                                        <td class="num">{{ formatBytes(a.bytes) }}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </details>
                </template>
                <p v-if="runError" class="bad">{{ runError }}</p>

                <div class="actions">
                    <button @click="cancel">{{ t("apply.cancel") }}</button>
                    <button class="danger" :disabled="!preview || preview.actions.length === 0" @click="run">
                        {{ permanent ? t("apply.runPermanent") : t("apply.runTrash") }}
                        <template v-if="preview">({{ preview.actions.length }})</template>
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px; }
.stats > div { background: var(--bg-3); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.stats b { font-size: 18px; }
.stats span { font-size: 12px; }
.counts { margin: 0 0 14px; font-size: 12.5px; }
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.warn, .bad { color: var(--delete); }
.warn { margin: 6px 0 0; font-size: 13px; }
details { margin-top: 14px; }
summary { cursor: pointer; color: var(--muted); }
.table { max-height: 220px; overflow: auto; margin-top: 8px; border: 1px solid var(--line); border-radius: 6px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 3px 8px; white-space: nowrap; }
td.name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
td.num { text-align: right; }
tr:nth-child(even) { background: var(--bg-3); }
.k-trash, .k-unlink { color: var(--delete); }
.k-move { color: var(--raw); }
.failures { max-height: 180px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; }
</style>

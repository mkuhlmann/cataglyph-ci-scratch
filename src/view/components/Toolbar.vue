<script setup lang="ts" vapor>
import { computed } from "vue";

import { counts, filter, tileSize, type Filter } from "../gallery.ts";
import { formatBytes, t } from "../i18n/index.ts";
import { closeFolder, eye, folder, ignored, items, openFolder, rpc, stacks } from "../state.ts";

const emit = defineEmits<{ open: [dialog: "apply" | "convert" | "settings"] }>();

const filters: Filter[] = ["all", "delete", "keep", "stacks", "hints", "raw", "video"];

const name = computed(() => folder.value.split(/[\\/]/).pop());
const running = computed(() => eye.value?.state === "running" || eye.value?.state === "starting");
const pct = computed(() => (eye.value && eye.value.total ? (eye.value.done / eye.value.total) * 100 : 0));
const accel = computed(() => {
    const e = eye.value;
    if (!e?.accelerator) return "";
    if (e.accelerator === "gpu") return e.adapter ? `GPU · ${e.adapter}` : "GPU";
    return "CPU";
});

async function pick() {
    const path = await rpc.pickFolder({});
    if (path) await openFolder(path);
}
</script>

<template>
    <header class="bar">
        <div class="row">
            <button class="ghost close" :title="t('toolbar.closeFolder')" @click="closeFolder">✕</button>
            <button class="ghost folder" :title="t('toolbar.openOther')" @click="pick">
                📁 <b>{{ name }}</b>
            </button>
            <span class="muted">{{ t("toolbar.items", { count: items.length }) }}<template v-if="ignored"> · {{ t("toolbar.ignored", { count: ignored }) }}</template></span>

            <div class="eye">
                <template v-if="eye">
                    <span v-if="eye.state === 'starting'" class="muted">{{ t("toolbar.eye.starting") }}</span>
                    <template v-else-if="eye.state === 'running'">
                        <span>{{ t("toolbar.eye.progress", { done: eye.done, total: eye.total }) }}</span>
                        <div class="progress mini"><div :style="{ width: pct + '%' }" /></div>
                        <span v-if="eye.meanMs" class="muted mono">{{ t("toolbar.eye.msPerImage", { ms: eye.meanMs }) }}</span>
                    </template>
                    <span v-else-if="eye.state === 'done' || (eye.total && eye.done === eye.total)" class="muted">
                        {{ t("toolbar.eye.done", { stacks: stacks.length }) }}
                    </span>
                    <span v-else-if="eye.state === 'error'" class="err" :title="eye.message">{{ t("toolbar.eye.error") }}</span>
                    <span v-if="accel" class="accel" :class="eye.accelerator">{{ accel }}</span>
                    <span v-if="eye.fellBackToCpu" class="muted">{{ t("toolbar.eye.fellBack") }}</span>
                </template>
                <button v-if="!running" @click="rpc.startAnalysis({}).then(e => (eye = e))">
                    {{ eye && eye.done > 0 && eye.done < eye.total ? t("toolbar.analyse.resume") : eye && eye.done === eye.total && eye.total ? t("toolbar.analyse.regroup") : t("toolbar.analyse.start") }}
                </button>
                <button v-else @click="rpc.stopAnalysis({})">{{ t("toolbar.analyse.stop") }}</button>
                <!-- Attribution required by the Desert Ant Labs license (§9: name + link to
                     desertant.com). Shown while their model is doing the work. -->
                <a
                    v-if="running"
                    class="credit"
                    href="https://desertant.com"
                    @click.prevent="rpc.openUrl({ url: 'https://desertant.com' })"
                >{{ t("toolbar.eye.credit") }}</a>
            </div>

            <div class="spacer" />
            <button class="ghost" :title="t('toolbar.settings')" @click="emit('open', 'settings')">⚙</button>
            <button class="danger" :disabled="counts.del === 0 && counts.bytes === 0" @click="emit('open', 'apply')">
                {{ t("toolbar.cleanup", { count: counts.del, size: formatBytes(counts.bytes) }) }}
            </button>
            <button class="primary" @click="emit('open', 'convert')">{{ t("toolbar.archive") }}</button>
        </div>
        <div class="row">
            <div class="filters">
                <button
                    v-for="key in filters"
                    :key="key"
                    class="chip"
                    :class="{ on: filter === key }"
                    @click="filter = key"
                >{{ t(`filter.${key}`) }}</button>
            </div>
            <div class="spacer" />
            <span class="muted keys">
                <kbd>C</kbd> {{ t("keys.keep") }} <kbd>X</kbd> {{ t("keys.delete") }} <kbd>R</kbd> {{ t("keys.raw") }} <kbd>S</kbd> {{ t("keys.stack") }}
                <kbd>U</kbd> {{ t("keys.undo") }} <kbd>Enter</kbd> {{ t("keys.detail") }}
            </span>
            <input v-model.number="tileSize" type="range" min="120" max="420" step="10" :title="t('toolbar.tileSize')" />
        </div>
    </header>
</template>

<style scoped>
.bar {
    background: var(--bg-2);
    border-bottom: 1px solid var(--line);
    padding: 8px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.row { display: flex; align-items: center; gap: 12px; }
.spacer { flex: 1; }
.close { font-size: 15px; padding: 2px 6px; margin-left: -6px; color: var(--muted); }
.close:hover { color: var(--text); }
.folder { font-size: 15px; padding-left: 0; }
.eye { display: flex; align-items: center; gap: 10px; margin-left: 12px; }
.progress.mini { width: 120px; }
.accel { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg-3); }
.accel.gpu { color: var(--keep); }
.accel.cpu { color: var(--warn); }
.err { color: var(--delete); }
.credit { font-size: 12px; color: var(--muted); text-decoration: none; }
.credit:hover { color: var(--accent); text-decoration: underline; }
.filters { display: flex; gap: 4px; }
.chip { padding: 3px 10px; border-radius: 999px; font-size: 12.5px; }
.chip.on { background: var(--accent); color: #08111d; border-color: var(--accent); }
.keys { font-size: 12px; }
</style>

<script setup lang="ts" vapor>
// Imported from assets/ (outside the Vite root) so the window/AppImage icon and the start
// screen logo share one source file.
import logo from "../../../assets/cataglyph.svg";
import { t } from "../i18n/index.ts";
import { openFolder, rpc, settings } from "../state.ts";

const EYE_URL = "https://desertant.com/models/eye/";

async function pick() {
    const path = await rpc.pickFolder({});
    if (path) await openFolder(path);
}
</script>

<template>
    <div class="start">
        <div class="card">
            <!-- Decorative: the app name right below says the same thing. -->
            <img class="logo" :src="logo" alt="" width="112" height="112" />
            <h1>Cataglyph</h1>
            <!-- Permanent home of the Desert Ant Labs attribution (license §9: name them, link
                 to desertant.com); the toolbar repeats it while an analysis runs. -->
            <a class="powered" :href="EYE_URL" @click.prevent="rpc.openUrl({ url: EYE_URL })">{{ t("start.poweredBy") }}</a>
            <p class="muted">{{ t("app.tagline") }}</p>
            <button class="primary big" @click="pick">{{ t("start.open") }}</button>
            <div v-if="settings?.recentFolders.length" class="recent">
                <h3>{{ t("start.recent") }}</h3>
                <button
                    v-for="f in settings.recentFolders"
                    :key="f"
                    class="ghost recent-item"
                    @click="openFolder(f)"
                >
                    <span class="name">{{ f.split(/[\\/]/).pop() }}</span>
                    <span class="muted mono">{{ f }}</span>
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Centred via the card's auto margins instead of align-items: center, which clips the top of
   an overflowing flex item: with the logo and eight recent folders the card is taller than a
   small window, and it has to scroll rather than lose the logo. */
.start {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow-y: auto;
}
.card { width: min(720px, 90vw); margin: auto; padding: 24px 0; text-align: center; }
.card p { font-size: 17px; line-height: 1.5; text-wrap: balance; }
.recent { text-align: left; margin-top: 12px; }
.logo { display: block; width: 112px; height: 112px; margin: 0 auto 16px; }
h1 { font-size: 44px; margin: 0 0 4px; letter-spacing: -0.01em; }
.powered { display: inline-block; margin-bottom: 14px; font-size: 11.5px; color: var(--muted); text-decoration: none; }
.powered:hover { color: var(--accent); text-decoration: underline; }
.big { padding: 12px 28px; font-size: 17px; margin: 18px 0 36px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.recent-item .name { font-size: 15px; }
.recent-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
}
.recent-item:hover { background: var(--bg-3); }
.name { font-weight: 600; }
</style>

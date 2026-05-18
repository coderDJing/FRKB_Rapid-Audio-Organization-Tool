<script setup lang="ts">
import chromeMiniimizeAsset from '@renderer/assets/chrome-minimize.svg?asset'
import logoAsset from '@renderer/assets/logo.png?asset'
import { computed, ref, watch } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import 'overlayscrollbars/overlayscrollbars.css'
import { t } from '@renderer/utils/translate'
import singleCheckbox from './components/singleCheckbox.vue'
import { useRuntimeStore } from '@renderer/stores/runtime'
import { formatWindowTitle } from '@renderer/utils/windowTitle'
import type { ReleaseNotesRangePayload } from '@shared/releaseNotes'
import {
  buildReleaseNotesMarkdown,
  renderMarkdownToHtml
} from '@renderer/utils/releaseNotesMarkdown'
const chromeMiniimize = chromeMiniimizeAsset
const logo = logoAsset

type FoundNewVersionPayload = {
  version: string
  releaseDate: string
  releaseNotes: ReleaseNotesRangePayload | null
  releaseNotesLoading: boolean
}

const toggleMinimize = () => {
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-minimize')
}
function getSevenDaysLaterISO() {
  const currentDate = new Date()
  const sevenDaysLater = new Date(currentDate.getTime() + 7 * 24 * 60 * 60 * 1000)
  return sevenDaysLater.toISOString()
}
const notCheckIn7Days = ref(false)
const runtime = useRuntimeStore()
const foundNewVersionTitle = computed(() => formatWindowTitle(t('update.newVersionFound')))
const latestVersion = ref('')
const releaseDate = ref('')
const releaseNotes = ref<ReleaseNotesRangePayload | null>(null)
const releaseNotesLoading = ref(true)
const releaseNotesHtml = ref('')
let releaseNotesRenderSeq = 0
const overlayOptions = {
  scrollbars: {
    autoHide: 'leave' as const,
    autoHideDelay: 50,
    clickScroll: true
  } as const,
  overflow: {
    x: 'hidden' as const,
    y: 'scroll' as const
  } as const
}

function convertISOToCustomFormat(isoString: string) {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

const channelText = computed(() => {
  if (releaseNotes.value?.channel === 'rc' || latestVersion.value.includes('-')) {
    return t('update.rcChannel')
  }
  return t('update.stableChannel')
})

const releaseRangeText = computed(() => {
  const current = releaseNotes.value?.currentVersion
  const latest = releaseNotes.value?.latestVersion || latestVersion.value
  if (!current || !latest) return ''
  return t('update.versionRange', { current, latest })
})

const updateReleaseNotesHtml = async (payload: ReleaseNotesRangePayload | null) => {
  const seq = ++releaseNotesRenderSeq
  if (!payload || payload.releases.length === 0) {
    releaseNotesHtml.value = ''
    return
  }
  const markdown = buildReleaseNotesMarkdown(payload, t('whatsNew.noChangelog'))
  const html = await renderMarkdownToHtml(markdown)
  if (seq === releaseNotesRenderSeq) {
    releaseNotesHtml.value = html
  }
}

window.electron.ipcRenderer.on(
  'foundNewVersion-data',
  (_event, payload: FoundNewVersionPayload) => {
    latestVersion.value = typeof payload?.version === 'string' ? payload.version : ''
    releaseDate.value = typeof payload?.releaseDate === 'string' ? payload.releaseDate : ''
    releaseNotes.value = payload?.releaseNotes || null
    releaseNotesLoading.value = payload?.releaseNotesLoading === true
    void updateReleaseNotesHtml(releaseNotes.value)
  }
)

watch(
  foundNewVersionTitle,
  (title) => {
    document.title = title
  },
  { immediate: true }
)

const toggleClose = async () => {
  if (notCheckIn7Days.value) {
    runtime.setting.nextCheckUpdateTime = getSevenDaysLaterISO()
    await window.electron.ipcRenderer.invoke(
      'setSetting',
      JSON.parse(JSON.stringify(runtime.setting))
    )
  }
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-close')
}
const startUpdate = async () => {
  await window.electron.ipcRenderer.invoke('foundNewVersionWindow-startUpdate')
  window.electron.ipcRenderer.send('foundNewVersionWindow-toggle-close')
}
</script>
<template>
  <div class="window-root unselectable">
    <div>
      <div class="title unselectable">{{ foundNewVersionTitle }}</div>
      <div class="titleComponent unselectable">
        <div
          v-if="runtime.setting.platform !== 'darwin'"
          style="
            z-index: 1;
            padding-left: 10px;
            display: flex;
            justify-content: center;
            align-items: center;
          "
        >
          <img :src="logo" style="width: 20px" :draggable="false" class="theme-icon" />
        </div>

        <div class="canDrag" style="flex-grow: 1; height: 35px; z-index: 1"></div>
        <div v-if="runtime.setting.platform !== 'darwin'" style="display: flex; z-index: 1">
          <div class="rightIcon" @click="toggleMinimize()">
            <img :src="chromeMiniimize" :draggable="false" />
          </div>
          <div class="rightIcon closeIcon" @click="toggleClose()">
            <svg
              width="15"
              height="15"
              viewBox="0 0 15 15"
              xmlns="http://www.w3.org/2000/svg"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M7.116 8l-4.558 4.558.884.884L8 8.884l4.558 4.558.884-.884L8.884 8l4.558-4.558-.884-.884L8 7.116 3.442 2.558l-.884.884L7.116 8z"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
    <main class="found-content">
      <section class="version-summary">
        <div class="channel-pill">{{ channelText }}</div>
        <div class="new-version-line">{{ t('update.newVersion') }} {{ latestVersion || '-' }}</div>
        <div v-if="releaseDate" class="muted-line">
          {{ t('update.releaseDate') }} {{ convertISOToCustomFormat(releaseDate) }}
        </div>
        <div v-if="releaseRangeText" class="muted-line">{{ releaseRangeText }}</div>
      </section>
      <section class="release-notes-panel">
        <div class="section-title">{{ t('update.releaseNotesTitle') }}</div>
        <div v-if="releaseNotesLoading" class="notes-status">
          <div class="loading small-loading"></div>
          <span>{{ t('update.releaseNotesLoading') }}</span>
        </div>
        <OverlayScrollbarsComponent
          v-else-if="releaseNotesHtml"
          class="release-notes-scroll"
          :options="overlayOptions"
          element="div"
          defer
        >
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="markdown-body" v-html="releaseNotesHtml"></div>
        </OverlayScrollbarsComponent>
        <div v-else class="notes-status">
          {{ t('update.releaseNotesEmpty') }}
        </div>
      </section>
    </main>
    <footer class="found-footer">
      <label class="skip-check-row">
        <singleCheckbox v-model="notCheckIn7Days" />
        <span>{{ t('update.doNotCheckFor7Days') }}</span>
      </label>
      <div class="footer-actions">
        <div class="button footer-button" @click="startUpdate()">
          {{ t('update.startUpdate') }}
        </div>
        <div class="button footer-button" @click="toggleClose()">
          {{ t('update.notNow') }}
        </div>
      </div>
    </footer>
  </div>
</template>
<style lang="scss">
.window-root {
  height: 100%;
  max-height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  color: var(--text);
  background-color: var(--bg);
  --release-notes-code-bg: rgba(255, 255, 255, 0.08);
  --release-notes-pre-bg: rgba(255, 255, 255, 0.06);
}

.button {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: var(--accent);
  }
}

#app {
  color: var(--text);
  background-color: var(--bg);
  width: 100vw;
  height: 100vh;
}

body {
  margin: 0px;
  background-color: var(--bg-elev);
}

.theme-light .window-root {
  --release-notes-code-bg: rgba(15, 23, 42, 0.06);
  --release-notes-pre-bg: rgba(15, 23, 42, 0.045);
}

.title {
  position: absolute;
  width: 100%;
  height: 34px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg);
  z-index: 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.titleComponent {
  width: 100vw;
  height: 35px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  box-sizing: border-box;

  .rightIcon {
    width: 47px;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 35px;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .rightIcon:hover {
    background-color: var(--hover);
  }

  .closeIcon {
    color: var(--text-weak);
  }

  .closeIcon:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

.found-content {
  flex: 1;
  min-height: 0;
  padding: 18px 22px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
}

.version-summary {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.channel-pill {
  width: fit-content;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: #ffffff;
  background-color: var(--accent);
}

.new-version-line {
  font-size: 20px;
  font-weight: 600;
}

.muted-line {
  font-size: 13px;
  color: var(--text-weak);
}

.release-notes-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background-color: var(--bg-elev);
}

.section-title {
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

.release-notes-scroll {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
}

.notes-status {
  flex: 1;
  min-height: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-weak);
  font-size: 13px;
}

.loading {
  width: 60px;
  height: 60px;
  border: 5px solid var(--text);
  border-top-color: transparent;
  border-radius: 100%;
  animation: circle infinite 0.75s linear;
}

.small-loading {
  width: 20px;
  height: 20px;
  border-width: 3px;
}

.found-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 12px 22px 18px;
  border-top: 1px solid var(--border);
}

.skip-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-weak);
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.footer-button {
  min-width: 92px;
  text-align: center;
}

.markdown-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin: 1em 0 0.5em;
    line-height: 1.25;
  }

  h2:first-child {
    margin-top: 0;
  }

  p {
    margin: 0.5em 0;
  }

  ul,
  ol {
    padding-left: 1.35em;
    margin: 0.5em 0;
  }

  code {
    background-color: var(--release-notes-code-bg);
    padding: 0.12em 0.3em;
    border-radius: 4px;
  }

  pre {
    padding: 10px;
    border-radius: 8px;
    background-color: var(--release-notes-pre-bg);
    overflow: auto;
  }
}

@keyframes circle {
  0% {
    transform: rotate(0);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>

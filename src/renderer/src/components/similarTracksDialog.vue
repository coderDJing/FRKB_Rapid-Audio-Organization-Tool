<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { v4 as uuidV4 } from 'uuid'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import { t } from '@renderer/utils/translate'
import utils from '@renderer/utils/utils'
import { useDialogTransition } from '@renderer/composables/useDialogTransition'
import { buildNeteaseSearchQuery, openNeteaseSearch } from '@renderer/utils/neteaseSearch'
import type {
  ISimilarTrackItem,
  ISimilarTrackSource,
  ISimilarTracksProviderStatus,
  ISimilarTracksResult,
  ISongInfo
} from 'src/types/globals'

type FilterKey = 'all' | 'listenbrainz' | 'lastfm' | 'both'

const props = defineProps<{
  song: ISongInfo
}>()
const emits = defineEmits(['close'])

const scope = uuidV4()
const { dialogVisible, closeWithAnimation } = useDialogTransition()
const loading = ref(false)
const errorText = ref('')
const result = ref<ISimilarTracksResult | null>(null)
const activeFilter = ref<FilterKey>('all')
const failedCoverKeys = ref(new Set<string>())

const closeDialog = () => {
  void window.electron.ipcRenderer.invoke('similarTracks:cancel').catch(() => {})
  closeWithAnimation(() => emits('close'))
}

const sourceLabel = (source: ISimilarTrackSource) =>
  source === 'listenbrainz'
    ? t('similarTracks.sourceListenBrainz')
    : t('similarTracks.sourceLastFm')

const sourceClass = (source: ISimilarTrackSource) =>
  source === 'listenbrainz' ? 'source-listenbrainz' : 'source-lastfm'

const mapError = (message: string) => {
  if (message === 'SIMILAR_TRACKS_NO_SEED') return t('similarTracks.errorNoSeed')
  if (message === 'ACOUSTID_CLIENT_MISSING') return t('similarTracks.errorAcoustIdMissing')
  if (message === 'SIMILAR_TRACKS_NETWORK') return t('similarTracks.errorNetwork')
  if (message === 'SIMILAR_TRACKS_TIMEOUT') return t('similarTracks.errorTimeout')
  if (message === 'SIMILAR_TRACKS_RATE_LIMITED') return t('similarTracks.errorRateLimited')
  return t('similarTracks.loadFailed', { message })
}

const loadSimilarTracks = async () => {
  if (loading.value) return
  loading.value = true
  errorText.value = ''
  try {
    const response = (await window.electron.ipcRenderer.invoke('similarTracks:find', {
      filePath: props.song.filePath,
      title: props.song.title || props.song.fileName,
      artist: props.song.artist,
      album: props.song.album,
      limit: 60
    })) as ISimilarTracksResult
    result.value = response
    activeFilter.value = 'all'
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    errorText.value = mapError(message)
    result.value = null
  } finally {
    loading.value = false
  }
}

const filteredTracks = computed(() => {
  const tracks = result.value?.tracks || []
  if (activeFilter.value === 'listenbrainz') {
    return tracks.filter((item) => item.sources.includes('listenbrainz'))
  }
  if (activeFilter.value === 'lastfm') {
    return tracks.filter((item) => item.sources.includes('lastfm'))
  }
  if (activeFilter.value === 'both') {
    return tracks.filter(
      (item) => item.sources.includes('listenbrainz') && item.sources.includes('lastfm')
    )
  }
  return tracks
})

const counts = computed<Record<FilterKey, number>>(() => {
  const tracks = result.value?.tracks || []
  return {
    all: tracks.length,
    listenbrainz: tracks.filter((item) => item.sources.includes('listenbrainz')).length,
    lastfm: tracks.filter((item) => item.sources.includes('lastfm')).length,
    both: tracks.filter(
      (item) => item.sources.includes('listenbrainz') && item.sources.includes('lastfm')
    ).length
  }
})

const filterTabs = computed<Array<{ key: FilterKey; label: string; count: number }>>(() => [
  { key: 'all', label: t('similarTracks.filterAll'), count: counts.value.all },
  {
    key: 'listenbrainz',
    label: t('similarTracks.filterListenBrainz'),
    count: counts.value.listenbrainz
  },
  { key: 'lastfm', label: t('similarTracks.filterLastFm'), count: counts.value.lastfm },
  { key: 'both', label: t('similarTracks.filterBoth'), count: counts.value.both }
])

const seedText = computed(() => {
  const seed = result.value?.seed
  if (!seed) return ''
  const parts = [seed.title, seed.artist].filter(Boolean)
  return parts.join(' - ')
})

const seedSourceText = computed(() => {
  const source = result.value?.seed?.source
  if (source === 'acoustid') return t('similarTracks.seedFromAcoustId')
  if (source === 'tags') return t('similarTracks.seedFromTags')
  return ''
})

const statusText = (status: ISimilarTracksProviderStatus) => {
  const label = sourceLabel(status.source)
  if (status.status === 'missing-key') return t('similarTracks.missingLastFmKey')
  if (status.status === 'no-seed') return t('similarTracks.missingListenBrainzSeed')
  if (status.status === 'error') {
    return t('similarTracks.providerError', {
      source: label,
      message: status.message || 'unknown'
    })
  }
  return t('similarTracks.providerOk', {
    source: label,
    count: status.count || 0
  })
}

const openTrackSource = (track: ISimilarTrackItem) => {
  const url =
    track.sourceUrls?.lastfm ||
    track.sourceUrls?.listenbrainz ||
    (track.recordingMbid
      ? `https://musicbrainz.org/recording/${encodeURIComponent(track.recordingMbid)}`
      : '')
  if (!url) return
  window.electron.ipcRenderer.send('openLocalBrowser', url)
}

const hasTrackSourceUrl = (track: ISimilarTrackItem) =>
  !!(track.sourceUrls?.lastfm || track.sourceUrls?.listenbrainz || track.recordingMbid)

const resolveNeteaseSearchQuery = (track: ISimilarTrackItem) =>
  buildNeteaseSearchQuery(track.title, track.artist)

const hasNeteaseSearchQuery = (track: ISimilarTrackItem) => !!resolveNeteaseSearchQuery(track)

const openTrackNeteaseSearch = (track: ISimilarTrackItem) => {
  openNeteaseSearch(resolveNeteaseSearchQuery(track))
}

const coverKey = (track: ISimilarTrackItem) => `${track.id}:${track.coverUrl || ''}`

const hasCover = (track: ISimilarTrackItem) =>
  !!track.coverUrl && !failedCoverKeys.value.has(coverKey(track))

const markCoverFailed = (track: ISimilarTrackItem) => {
  failedCoverKeys.value = new Set(failedCoverKeys.value).add(coverKey(track))
}

const coverFallbackText = (track: ISimilarTrackItem) => {
  const text = (track.title || track.artist || '').trim()
  const [firstChar] = Array.from(text)
  return firstChar ? firstChar.toLocaleUpperCase() : '#'
}

onMounted(() => {
  utils.setHotkeysScpoe(scope)
  hotkeys('esc', scope, () => {
    closeDialog()
    return false
  })
  void loadSimilarTracks()
})

onUnmounted(() => {
  utils.delHotkeysScope(scope)
  void window.electron.ipcRenderer.invoke('similarTracks:cancel').catch(() => {})
})
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">{{ t('similarTracks.title') }}</div>

      <div class="similar-body">
        <div class="seed-panel">
          <div class="seed-main">
            <span class="seed-label">{{ t('similarTracks.seedLabel') }}</span>
            <span class="seed-title">{{
              seedText || props.song.title || props.song.fileName
            }}</span>
          </div>
          <span v-if="seedSourceText" class="source-chip seed-source">{{ seedSourceText }}</span>
        </div>

        <div class="source-status">
          <span
            v-for="status in result?.providerStatus || []"
            :key="status.source"
            class="status-pill"
            :class="{
              warn: status.status === 'missing-key' || status.status === 'no-seed',
              error: status.status === 'error'
            }"
          >
            {{ statusText(status) }}
          </span>
        </div>

        <div class="filter-tabs">
          <button
            v-for="tab in filterTabs"
            :key="tab.key"
            class="filter-tab"
            :class="{ active: activeFilter === tab.key }"
            type="button"
            @click="activeFilter = tab.key"
          >
            <span>{{ tab.label }}</span>
            <span class="count">{{ tab.count }}</span>
          </button>
        </div>

        <div class="result-panel">
          <div v-if="loading" class="placeholder">{{ t('similarTracks.loading') }}</div>
          <div v-else-if="errorText" class="placeholder error-text">{{ errorText }}</div>
          <div v-else-if="!result?.tracks.length" class="placeholder">
            {{ t('similarTracks.noResults') }}
          </div>
          <div v-else-if="!filteredTracks.length" class="placeholder">
            {{ t('similarTracks.noFilteredResults') }}
          </div>
          <OverlayScrollbarsComponent
            v-else
            class="result-scroll"
            element="div"
            :options="{
              scrollbars: { autoHide: 'leave' as const, autoHideDelay: 50, clickScroll: true },
              overflow: { x: 'hidden', y: 'scroll' } as const
            }"
          >
            <div class="result-list">
              <div v-for="track in filteredTracks" :key="track.id" class="track-row">
                <div class="cover-box">
                  <img
                    v-if="hasCover(track)"
                    :src="track.coverUrl"
                    alt=""
                    draggable="false"
                    decoding="async"
                    @error="markCoverFailed(track)"
                  />
                  <span v-else class="cover-fallback">{{ coverFallbackText(track) }}</span>
                </div>
                <div class="track-main">
                  <div class="track-title">{{ track.title }}</div>
                  <div class="track-meta">
                    <span>{{ track.artist }}</span>
                    <span>{{ track.album || t('similarTracks.albumUnknown') }}</span>
                  </div>
                  <div class="track-sources">
                    <span
                      v-for="source in track.sources"
                      :key="source"
                      class="source-chip"
                      :class="sourceClass(source)"
                    >
                      {{ sourceLabel(source) }}
                    </span>
                  </div>
                </div>
                <div class="track-side">
                  <div class="score">{{ t('similarTracks.score', { score: track.score }) }}</div>
                  <div class="track-actions">
                    <button
                      class="open-button"
                      type="button"
                      :disabled="!hasTrackSourceUrl(track)"
                      @click="openTrackSource(track)"
                    >
                      {{ t('similarTracks.openSource') }}
                    </button>
                    <button
                      class="open-button"
                      type="button"
                      :disabled="!hasNeteaseSearchQuery(track)"
                      @click="openTrackNeteaseSearch(track)"
                    >
                      {{ t('similarTracks.searchNetease') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </OverlayScrollbarsComponent>
        </div>
      </div>

      <div class="dialog-footer">
        <div class="button" @click="loadSimilarTracks">{{ t('similarTracks.retry') }}</div>
        <div class="button" @click="closeDialog">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.inner {
  width: 820px;
  height: 620px;
  max-height: 86vh;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.similar-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 0;
}

.seed-panel {
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
}

.seed-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.seed-label {
  font-size: 11px;
  color: var(--text-weak);
}

.seed-title {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-chip {
  height: 22px;
  line-height: 20px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-weak);
  background-color: var(--bg);
  box-sizing: border-box;
}

.source-status {
  min-height: 24px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status-pill {
  height: 22px;
  line-height: 20px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-weak);
  background-color: var(--bg);
  box-sizing: border-box;
}

.status-pill.warn {
  border-color: rgba(234, 179, 8, 0.5);
  color: #b7791f;
}

.status-pill.error {
  border-color: rgba(239, 68, 68, 0.45);
  color: #dc2626;
}

.seed-source {
  flex: 0 0 auto;
}

.source-listenbrainz {
  border-color: rgba(34, 197, 94, 0.45);
  color: #15803d;
}

.source-lastfm {
  border-color: rgba(239, 68, 68, 0.42);
  color: #dc2626;
}

.filter-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-tab {
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-elev);
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  cursor: pointer;

  &:hover,
  &.active {
    border-color: var(--accent);
    background-color: var(--hover);
  }
}

.count {
  min-width: 18px;
  height: 18px;
  border-radius: 999px;
  background-color: var(--bg);
  color: var(--text-weak);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.result-panel {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg);
  overflow: hidden;
}

.placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.error-text {
  color: #dc2626;
}

.result-scroll {
  height: 100%;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.track-row {
  min-height: 86px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background-color: var(--bg-elev);
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 184px;
  gap: 12px;
  align-items: center;
  padding: 10px 12px 10px 10px;
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease,
    transform 0.16s ease;

  &:hover {
    border-color: var(--accent);
    background-color: var(--hover);
    transform: translateY(-1px);
  }
}

.cover-box {
  width: 58px;
  height: 58px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0)), var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-weak);
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(34, 197, 94, 0.12)), var(--bg);
}

.track-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.track-title {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-meta {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr);
  gap: 12px;
  color: var(--text-weak);
  font-size: 12px;

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.track-sources {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.track-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.track-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.score {
  min-width: 52px;
  height: 24px;
  border: 1px solid rgba(34, 197, 94, 0.32);
  border-radius: 999px;
  background-color: rgba(34, 197, 94, 0.08);
  font-size: 12px;
  color: var(--text);
  font-weight: 700;
  line-height: 22px;
  text-align: center;
}

.open-button {
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg);
  color: var(--text);
  padding: 0 10px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background-color: var(--accent);
    color: #ffffff;
  }

  &:disabled {
    cursor: default;
    opacity: 0.45;
    background-color: var(--bg);
    color: var(--text-weak);
  }
}

.dialog-footer {
  flex-shrink: 0;
}
</style>

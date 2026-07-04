<script setup lang="ts">
import { computed, inject } from 'vue'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-vue'
import bubbleBox from '@renderer/components/bubbleBox.vue'
import bubbleBoxTrigger from '@renderer/components/bubbleBoxTrigger.vue'
import singleCheckbox from '@renderer/components/singleCheckbox.vue'
import singleRadioGroup from '@renderer/components/singleRadioGroup.vue'
import BaseSelect from '@renderer/components/BaseSelect.vue'
import { t } from '@renderer/utils/translate'
import {
  settingDialogContextKey,
  type SettingDialogContext
} from '@renderer/components/settingDialog/context'
import {
  PLAYBACK_RANGE_SECTION_KINDS,
  PLAYBACK_RANGE_SECTION_LABELS,
  normalizePlaybackRangeSectionKinds,
  type PlaybackRangeMode,
  type PlaybackRangeSectionMatchMode
} from '@shared/playbackRange'
import type { SongStructureSectionKind } from '@shared/songStructure'

const ctx = inject<SettingDialogContext>(settingDialogContextKey)

if (!ctx) {
  throw new Error('settingDialogContext is missing')
}

const {
  dialogVisible,
  runtime,
  cancel,
  setSetting,
  songFingerprintListLength,
  acoustIdKeyValidating,
  acoustIdKeyErrorText,
  isWindowsPlatform,
  curatedArtistFavoritesCount,
  isDevOrPrerelease,
  songListBubbleMode,
  isEnumeratingAudioOutputs,
  audioOutputError,
  audioOutputSupported,
  themeModeOptions,
  languageOptions,
  waveformModeOptions,
  keyDisplayStyleOptions,
  audioOutputSelectOptions,
  handleAudioOutputChange,
  openAcoustIdSite,
  handleAcoustIdKeyBlur,
  updateRecentDialogCacheMaxCount,
  allFormats,
  audioExt,
  extChange,
  clearTracksFingerprintLibrary,
  clearCuratedArtistFavorites,
  openCuratedArtistFavoritesDialog,
  globalCallShortcutHandle,
  playerGlobalShortcutHandle,
  reSelectLibrary,
  chooseRekordboxDesktopTrackStorageDir,
  hintIcon,
  fpModeHintRefs,
  bindFpModeHintRef,
  onFingerprintModeChange,
  clearCloudFingerprints,
  clearLibraryDirtyData,
  clearAnalysisRuntime
} = ctx

const fingerprintModeModel = computed<'pcm' | 'file'>({
  get: () => runtime.setting.fingerprintMode || 'pcm',
  set: (value) => {
    runtime.setting.fingerprintMode = value
  }
})

const showIdleAnalysisStatusModel = computed<boolean>({
  get: () => runtime.setting.showIdleAnalysisStatus === true,
  set: (value) => {
    runtime.setting.showIdleAnalysisStatus = value
  }
})

const autoFillSkipCompletedModel = computed<boolean>({
  get: () => runtime.setting.autoFillSkipCompleted !== false,
  set: (value) => {
    runtime.setting.autoFillSkipCompleted = value
  }
})

const enableExplorerContextMenuModel = computed<boolean>({
  get: () => runtime.setting.enableExplorerContextMenu === true,
  set: (value) => {
    runtime.setting.enableExplorerContextMenu = value
  }
})

const showTitleAudioVisualizerModel = computed<boolean>({
  get: () => runtime.setting.showTitleAudioVisualizer !== false,
  set: (value) => {
    runtime.setting.showTitleAudioVisualizer = value
  }
})

const playbackRangeModeModel = computed<PlaybackRangeMode>({
  get: () => (runtime.setting.playbackRangeMode === 'section' ? 'section' : 'custom'),
  set: (value) => {
    runtime.setting.playbackRangeMode = value
  }
})

const playbackRangeSectionMatchModeModel = computed<PlaybackRangeSectionMatchMode>({
  get: () => {
    const value = runtime.setting.playbackRangeSectionMatchMode
    return value === 'first' || value === 'last' ? value : 'all'
  },
  set: (value) => {
    runtime.setting.playbackRangeSectionMatchMode = value
  }
})

const playbackRangeModeOptions = computed(() => [
  { label: t('player.playbackRangeModeCustom'), value: 'custom' },
  { label: t('player.playbackRangeModeSection'), value: 'section' }
])

const playbackRangeSectionMatchModeOptions = computed(() => [
  { label: t('player.playbackRangeSectionMatchAll'), value: 'all' },
  { label: t('player.playbackRangeSectionMatchFirst'), value: 'first' },
  { label: t('player.playbackRangeSectionMatchLast'), value: 'last' }
])

const playbackRangeSectionKindOptions = computed(() =>
  PLAYBACK_RANGE_SECTION_KINDS.map((kind) => ({
    label: PLAYBACK_RANGE_SECTION_LABELS[kind],
    value: kind
  }))
)

const playbackRangeSelectedSectionKinds = computed(
  () => new Set(normalizePlaybackRangeSectionKinds(runtime.setting.playbackRangeSectionKinds))
)

const togglePlaybackRangeSectionKind = (kind: SongStructureSectionKind, checked: boolean) => {
  const current = normalizePlaybackRangeSectionKinds(runtime.setting.playbackRangeSectionKinds)
  const selected = new Set(current)
  if (checked) {
    selected.add(kind)
  } else if (selected.size > 1) {
    selected.delete(kind)
  }
  runtime.setting.playbackRangeSectionKinds = PLAYBACK_RANGE_SECTION_KINDS.filter((item) =>
    selected.has(item)
  )
  setSetting()
}

const currentLibraryPathText = computed(
  () => runtime.setting.databaseUrl || t('database.notConfigured')
)
const rekordboxDesktopTrackStorageDirText = computed(
  () =>
    runtime.setting.rekordboxDesktopTrackStorageDir ||
    t('settings.rekordboxDesktopTrackStorageDir.notConfigured')
)
</script>

<template>
  <div class="dialog unselectable" :class="{ 'dialog-visible': dialogVisible }">
    <div v-dialog-drag="'.dialog-title'" class="inner">
      <div class="dialog-title dialog-header">
        <span>{{ t('common.setting') }}</span>
      </div>
      <OverlayScrollbarsComponent
        :options="{
          scrollbars: {
            autoHide: 'leave' as const,
            autoHideDelay: 50,
            clickScroll: true
          } as const,
          overflow: {
            x: 'hidden',
            y: 'scroll'
          } as const
        }"
        element="div"
        class="dialog-scroll"
        defer
      >
        <div class="dialog-content">
          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionCommonTitle') }}</div>

            <div class="setting-block">{{ t('theme.mode') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.themeMode"
                :options="themeModeOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('common.language') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.language"
                :options="languageOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('player.audioOutputDevice') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.audioOutputDeviceId"
                :options="audioOutputSelectOptions"
                :width="280"
                :disabled="!audioOutputSupported || isEnumeratingAudioOutputs"
                @change="handleAudioOutputChange"
              />
              <div v-if="audioOutputError" class="error-text">{{ audioOutputError }}</div>
            </div>

            <div class="setting-block">{{ t('shortcuts.globalCallShortcut') }}：</div>
            <div class="setting-control">
              <bubbleBoxTrigger
                tag="div"
                class="chooseDirDiv"
                :title="runtime.setting.globalCallShortcut"
                @click="globalCallShortcutHandle()"
              >
                {{ runtime.setting.globalCallShortcut }}
              </bubbleBoxTrigger>
            </div>

            <label class="setting-block" for="setting-checkbox-autoPlayNext"
              >{{ t('player.autoPlayNext') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoPlayNext"
                v-model="runtime.setting.autoPlayNextSong"
                @change="setSetting()"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-autoCenterSong"
              >{{ t('player.autoCenterSong') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoCenterSong"
                v-model="runtime.setting.autoScrollToCurrentSong"
                @change="setSetting()"
              />
            </div>

            <div class="setting-block">{{ t('player.recentPlaylistCache') }}：</div>
            <div class="setting-control">
              <input
                v-model="runtime.setting.recentDialogSelectedSongListMaxCount"
                class="myInput"
                type="number"
                min="0"
                step="1"
                @input="
                  runtime.setting.recentDialogSelectedSongListMaxCount = Math.max(
                    0,
                    Math.floor(Number(runtime.setting.recentDialogSelectedSongListMaxCount || 0))
                  )
                "
                @blur="updateRecentDialogCacheMaxCount()"
              />
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionPlaybackRangeTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-enablePlaybackRange"
              >{{ t('player.enablePlaybackRange') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-enablePlaybackRange"
                v-model="runtime.setting.enablePlaybackRange"
                @change="setSetting()"
              />
            </div>

            <template v-if="runtime.setting.enablePlaybackRange">
              <div class="setting-block">{{ t('player.playbackRangeMode') }}：</div>
              <div class="setting-control">
                <BaseSelect
                  v-model="playbackRangeModeModel"
                  :options="playbackRangeModeOptions"
                  :width="220"
                  @change="setSetting"
                />
              </div>

              <template v-if="playbackRangeModeModel === 'section'">
                <div class="setting-block">{{ t('player.playbackRangeSectionKinds') }}：</div>
                <div class="setting-control section-kind-list">
                  <singleCheckbox
                    v-for="option in playbackRangeSectionKindOptions"
                    :id="`setting-checkbox-playbackRangeSection-${option.value}`"
                    :key="option.value"
                    class="section-kind-item"
                    :model-value="playbackRangeSelectedSectionKinds.has(option.value)"
                    @change="
                      (checked) => togglePlaybackRangeSectionKind(option.value, Boolean(checked))
                    "
                  >
                    {{ option.label }}
                  </singleCheckbox>
                </div>

                <div class="setting-block">{{ t('player.playbackRangeSectionMatchMode') }}：</div>
                <div class="setting-control">
                  <BaseSelect
                    v-model="playbackRangeSectionMatchModeModel"
                    :options="playbackRangeSectionMatchModeOptions"
                    :width="220"
                    @change="setSetting"
                  />
                </div>
              </template>
            </template>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionPlaybackTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-hideControlsShowWaveform"
              >{{ t('player.hideControlsShowWaveform') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-hideControlsShowWaveform"
                v-model="runtime.setting.hiddenPlayControlArea"
                @change="setSetting()"
              />
            </div>

            <div class="setting-block">{{ t('player.waveformMode') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.waveformMode"
                :options="waveformModeOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('player.keyDisplayStyle') }}：</div>
            <div class="setting-control">
              <BaseSelect
                v-model="runtime.setting.keyDisplayStyle"
                :options="keyDisplayStyleOptions"
                :width="220"
                @change="setSetting"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-showTitleAudioVisualizer"
              >{{ t('player.showTitleAudioVisualizer') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showTitleAudioVisualizer"
                v-model="showTitleAudioVisualizerModel"
                @change="setSetting()"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-showIdleAnalysisStatus"
              >{{ t('player.showIdleAnalysisStatus') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showIdleAnalysisStatus"
                v-model="showIdleAnalysisStatusModel"
                @change="setSetting"
              />
            </div>

            <div class="setting-block">{{ t('shortcuts.playerGlobalShortcuts') }}：</div>
            <div class="setting-control">
              <div class="playerShortcutList">
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalFastForwardShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.fastForward"
                    @click="playerGlobalShortcutHandle('fastForward')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.fastForward }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">
                    {{ t('shortcuts.globalFastBackwardShortcut') }}
                  </div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.fastBackward"
                    @click="playerGlobalShortcutHandle('fastBackward')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.fastBackward }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">{{ t('shortcuts.globalNextShortcut') }}</div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.nextSong"
                    @click="playerGlobalShortcutHandle('nextSong')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.nextSong }}
                  </bubbleBoxTrigger>
                </div>
                <div class="playerShortcutRow">
                  <div class="playerShortcutLabel">{{ t('shortcuts.globalPreviousShortcut') }}</div>
                  <bubbleBoxTrigger
                    tag="div"
                    class="chooseDirDiv"
                    :title="runtime.setting.playerGlobalShortcuts.previousSong"
                    @click="playerGlobalShortcutHandle('previousSong')"
                  >
                    {{ runtime.setting.playerGlobalShortcuts.previousSong }}
                  </bubbleBoxTrigger>
                </div>
              </div>
              <div class="playerShortcutHint">{{ t('shortcuts.playerGlobalShortcutsHint') }}</div>
            </div>

            <div class="setting-block">{{ t('player.fastForwardTime') }}：</div>
            <div class="setting-control number-row">
              <input
                v-model="runtime.setting.fastForwardTime"
                class="myInput"
                type="number"
                min="1"
                step="1"
                @input="
                  runtime.setting.fastForwardTime = Math.max(
                    1,
                    Math.floor(Number(runtime.setting.fastForwardTime || 1))
                  )
                "
                @blur="setSetting()"
              />
              <span>{{ t('player.seconds') }}</span>
            </div>

            <div class="setting-block">{{ t('player.fastBackwardTime') }}：</div>
            <div class="setting-control number-row">
              <input
                v-model="runtime.setting.fastBackwardTime"
                class="myInput"
                type="number"
                max="-1"
                step="1"
                @input="
                  runtime.setting.fastBackwardTime = Math.min(
                    -1,
                    Math.floor(Number(runtime.setting.fastBackwardTime || -1))
                  )
                "
                @blur="setSetting()"
              />
              <span>{{ t('player.seconds') }}</span>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionMetadataTitle') }}</div>

            <div class="setting-block">{{ t('metadata.acoustidSettingTitle') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc1') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc2') }}</div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingDesc3') }}</div>
              <div class="acoustid-row">
                <input
                  v-model="runtime.setting.acoustIdClientKey"
                  class="acoustid-input"
                  :class="{ invalid: acoustIdKeyErrorText }"
                  :placeholder="t('metadata.acoustidSettingPlaceholder')"
                  :disabled="acoustIdKeyValidating"
                  @blur="handleAcoustIdKeyBlur"
                />
                <div class="button settings-inline-button" @click="openAcoustIdSite">
                  {{ t('metadata.acoustidSettingOpenLink') }}
                </div>
              </div>
              <div v-if="acoustIdKeyValidating" class="setting-hint">
                {{ t('metadata.acoustidKeyValidating') }}
              </div>
              <div v-else-if="acoustIdKeyErrorText" class="error-text">
                {{ acoustIdKeyErrorText }}
              </div>
              <div class="setting-hint">{{ t('metadata.acoustidSettingRateHint') }}</div>
            </div>

            <label class="setting-block" for="setting-checkbox-autoFillSkipCompleted"
              >{{ t('metadata.autoFillSkipCompleted') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-autoFillSkipCompleted"
                v-model="autoFillSkipCompletedModel"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('metadata.autoFillSkipCompletedHint') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.mode') }}：</div>
            <div class="setting-control">
              <singleRadioGroup
                v-model="fingerprintModeModel"
                name="fpMode"
                :options="[
                  { label: t('fingerprints.modePCM'), value: 'pcm' },
                  { label: t('fingerprints.modeFile'), value: 'file' }
                ]"
                @change="onFingerprintModeChange()"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                  <img
                    :ref="bindFpModeHintRef(opt.value)"
                    :src="hintIcon"
                    style="width: 14px; height: 14px; margin-left: 6px"
                    :draggable="false"
                  />
                  <bubbleBox
                    :dom="fpModeHintRefs[opt.value] || null"
                    :title="
                      opt.value === 'pcm'
                        ? t('fingerprints.modePCMHint')
                        : t('fingerprints.modeFileHint')
                    "
                    :max-width="360"
                  />
                </template>
              </singleRadioGroup>
              <div class="setting-hint">{{ t('fingerprints.modeIncompatibleWarning') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.scanFormats') }}：</div>
            <div class="setting-control">
              <div class="formatList">
                <template v-for="fmt in allFormats" :key="fmt">
                  <div class="formatItem">
                    <label :for="'setting-checkbox-ext-' + fmt" style="user-select: none"
                      >.{{ fmt }}</label
                    >
                    <singleCheckbox
                      :id="'setting-checkbox-ext-' + fmt"
                      v-model="audioExt[fmt]"
                      @change="extChange()"
                    />
                  </div>
                </template>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">{{ t('settings.layout.sectionLibraryTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-persistFiltersAfterRestart"
              >{{ t('filters.persistFiltersAfterRestart') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-persistFiltersAfterRestart"
                v-model="runtime.setting.persistSongFilters"
                @change="setSetting()"
              />
            </div>

            <label class="setting-block" for="setting-checkbox-curatedArtistTracking"
              >{{ t('settings.curatedArtistTracking.title') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-curatedArtistTracking"
                v-model="runtime.setting.enableCuratedArtistTracking"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('settings.curatedArtistTracking.desc') }}</div>
              <div class="setting-hint">
                {{
                  t('settings.curatedArtistTracking.clearDesc', {
                    count: curatedArtistFavoritesCount
                  })
                }}
              </div>
              <div class="buttonRow">
                <div
                  class="button settings-inline-button"
                  @click="openCuratedArtistFavoritesDialog()"
                >
                  {{ t('settings.curatedArtistTracking.managerButton') }}
                </div>
                <div
                  class="dangerButton settings-inline-button"
                  @click="clearCuratedArtistFavorites()"
                >
                  {{ t('settings.curatedArtistTracking.clearButton') }}
                </div>
              </div>
            </div>

            <label class="setting-block" for="setting-checkbox-showPlaylistTrackCount"
              >{{ t('settings.showPlaylistTrackCount') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-showPlaylistTrackCount"
                v-model="runtime.setting.showPlaylistTrackCount"
                @change="setSetting()"
              />
            </div>

            <template v-if="isWindowsPlatform">
              <label class="setting-block" for="setting-checkbox-enableExplorerContextMenu"
                >{{ t('settings.enableExplorerContextMenu') }}：</label
              >
              <div class="setting-control">
                <singleCheckbox
                  id="setting-checkbox-enableExplorerContextMenu"
                  v-model="enableExplorerContextMenuModel"
                  @change="setSetting()"
                />
              </div>
            </template>

            <div class="setting-block">{{ t('settings.songListBubble.title') }}：</div>
            <div class="setting-control">
              <singleRadioGroup
                v-model="songListBubbleMode"
                name="songListBubble"
                :options="[
                  { label: t('settings.songListBubble.overflowOnly'), value: 'overflowOnly' },
                  { label: t('settings.songListBubble.always'), value: 'always' }
                ]"
                :option-font-size="12"
                @change="setSetting()"
              >
                <template #option="{ opt }">
                  <span class="label">{{ opt.label }}</span>
                </template>
              </singleRadioGroup>
              <div class="setting-hint">{{ t('settings.songListBubble.hint') }}</div>
            </div>

            <div class="setting-block">{{ t('settings.currentLibraryPath') }}：</div>
            <div class="setting-control">
              <bubbleBoxTrigger tag="div" class="path-display" :title="currentLibraryPathText">
                {{ currentLibraryPathText }}
              </bubbleBoxTrigger>
              <div class="setting-hint">{{ t('settings.currentLibraryPathHint') }}</div>
            </div>

            <div class="setting-block">
              {{ t('settings.rekordboxDesktopTrackStorageDir.title') }}：
            </div>
            <div class="setting-control">
              <bubbleBoxTrigger
                tag="div"
                class="path-display"
                :title="rekordboxDesktopTrackStorageDirText"
              >
                {{ rekordboxDesktopTrackStorageDirText }}
              </bubbleBoxTrigger>
              <div class="setting-hint">
                {{ t('settings.rekordboxDesktopTrackStorageDir.hint') }}
              </div>
              <div class="buttonRow">
                <div
                  class="button settings-inline-button"
                  @click="chooseRekordboxDesktopTrackStorageDir()"
                >
                  {{ t('settings.rekordboxDesktopTrackStorageDir.chooseButton') }}
                </div>
              </div>
            </div>

            <div class="setting-block">{{ t('database.reselectLocation') }}：</div>
            <div class="setting-control">
              <div class="button settings-inline-button" @click="reSelectLibrary()">
                {{ t('dialog.reselect') }}
              </div>
            </div>
          </div>

          <div class="settings-section settings-section--danger">
            <div class="section-title">{{ t('settings.layout.sectionSafetyTitle') }}</div>

            <label class="setting-block" for="setting-checkbox-enableErrorReport"
              >{{ t('errorReport.enable') }}：</label
            >
            <div class="setting-control">
              <singleCheckbox
                id="setting-checkbox-enableErrorReport"
                v-model="runtime.setting.enableErrorReport"
                @change="setSetting()"
              />
              <div class="setting-hint">{{ t('errorReport.hint') }}</div>
            </div>

            <div class="setting-block">{{ t('fingerprints.clear') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">
                {{ t('fingerprints.currentCount', { count: songFingerprintListLength }) }}
              </div>
              <div class="actionRow">
                <div
                  class="dangerButton settings-inline-button"
                  @click="clearTracksFingerprintLibrary()"
                >
                  {{ t('fingerprints.clearShort') }}
                </div>
              </div>
            </div>

            <div class="setting-block">{{ t('cloudSync.reset.sectionTitle') }}：</div>
            <div class="setting-control">
              <div class="setting-hint">{{ t('cloudSync.reset.description') }}</div>
              <div class="actionRow">
                <div class="dangerButton settings-inline-button" @click="clearCloudFingerprints()">
                  {{ t('cloudSync.reset.short') }}
                </div>
              </div>
            </div>

            <template v-if="isDevOrPrerelease">
              <div class="setting-block">{{ t('settings.clearDirtyData.title') }}：</div>
              <div class="setting-control">
                <div class="setting-hint">{{ t('settings.clearDirtyData.desc') }}</div>
                <div class="actionRow">
                  <div class="dangerButton settings-inline-button" @click="clearLibraryDirtyData()">
                    {{ t('settings.clearDirtyData.button') }}
                  </div>
                </div>
              </div>

              <div class="setting-block">{{ t('settings.clearAnalysisRuntime.title') }}：</div>
              <div class="setting-control">
                <div class="setting-hint">{{ t('settings.clearAnalysisRuntime.desc') }}</div>
                <div class="actionRow">
                  <div class="dangerButton settings-inline-button" @click="clearAnalysisRuntime()">
                    {{ t('settings.clearAnalysisRuntime.button') }}
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </OverlayScrollbarsComponent>
      <div class="dialog-footer">
        <div class="button" @click="cancel">{{ t('common.close') }} (Esc)</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.inner {
  width: 60vw;
  height: 70vh;
  display: flex;
  flex-direction: column;
}

.dialog-scroll {
  height: 100%;
  width: 100%;
}

.dialog-content {
  padding: 20px;
  font-size: 14px;
  flex-grow: 1;
}

.settings-section {
  padding-top: 2px;
  margin-top: 30px;
}

.settings-section:first-child {
  margin-top: 0;
}

.settings-section--danger {
  margin-top: 34px;
}

.section-title {
  position: relative;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  padding-left: 12px;
  margin-bottom: 4px;
}

.section-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 4px;
  height: 14px;
  border-radius: 999px;
  background: rgba(0, 120, 212, 0.52);
  transform: translateY(-50%);
}

.settings-section--danger .section-title {
  color: var(--text);
}

.settings-section--danger .section-title::before {
  background: rgba(232, 17, 35, 0.5);
}

.setting-block {
  margin-top: 20px;
}

label.setting-block {
  display: block;
  user-select: none;
}

.setting-control {
  margin-top: 10px;
  max-width: 100%;
}

.number-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.buttonRow {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.actionRow {
  margin-top: 10px;
}

.formatList {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.formatItem {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 82px;
}

.section-kind-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  max-width: 360px;
}

.section-kind-item {
  min-width: 86px;
}

.myInput {
  width: 72px;
  height: 26px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  outline: none;
  color: var(--text);
  border-radius: 3px;
  padding: 0 6px;

  &:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
  }
}

.dangerButton {
  height: 25px;
  line-height: 25px;
  padding: 0 10px;
  border-radius: 5px;
  background-color: var(--hover);
  border: 1px solid var(--border);
  font-size: 14px;

  &:hover {
    color: #ffffff;
    background-color: #e81123;
  }
}

.chooseDirDiv {
  height: 25px;
  line-height: 25px;
  background-color: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 14px;
  padding-left: 5px;
  box-sizing: border-box;
  width: 220px;
  max-width: 100%;

  &:hover {
    background-color: var(--hover);
    border-color: var(--accent);
  }
}

.path-display {
  width: min(520px, 100%);
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-elev);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  white-space: normal;
  word-break: break-all;
  user-select: text;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary, #8c8c8c);
  margin-top: 8px;
  line-height: 1.5;
}

.settings-inline-button {
  width: fit-content;
  min-width: 110px;
  text-align: center;
}

.acoustid-row {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}

.acoustid-input {
  width: 280px;
  max-width: 100%;
  height: 25px;
  border: 1px solid var(--border);
  background-color: var(--bg-elev);
  color: var(--text);
  border-radius: 3px;
  padding: 0 8px;
  outline: none;
}

.acoustid-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.25);
}

.acoustid-input.invalid {
  border-color: #e81123;
}

.error-text {
  color: #e81123;
  font-size: 12px;
  margin-top: 6px;
}

.playerShortcutList {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.playerShortcutRow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.playerShortcutLabel {
  min-width: 130px;
  font-size: 13px;
  color: var(--text-weak);
}

.playerShortcutHint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-weak);
}

@media (max-width: 900px) {
  .inner {
    width: 90vw;
    height: 84vh;
  }

  .settings-section {
    margin-top: 26px;
  }

  .playerShortcutRow {
    flex-direction: column;
    align-items: stretch;
  }

  .playerShortcutLabel {
    min-width: 0;
  }

  .acoustid-row {
    flex-direction: column;
    align-items: stretch;
  }

  .chooseDirDiv,
  .acoustid-input {
    width: 100%;
  }
}
</style>

import { computed, onMounted, onUnmounted, watch, type Ref, type ComputedRef } from 'vue'
import type { ISongInfo } from 'src/types/globals'
import type { WebAudioPlayer } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type { useRuntimeStore } from '@renderer/stores/runtime'
import {
  MINI_PLAYER_CHANNELS,
  type MiniPlayerCommand,
  type MiniPlayerHostState,
  type MiniPlayerPlayhead,
  type MiniPlayerSession
} from '@shared/miniPlayerWindow'
import type {
  LibraryTransferActionMode,
  LibraryTransferTarget
} from '@renderer/utils/libraryTransfer'
import { cloneMiniPlayerHostState } from '@renderer/composables/miniPlayer/miniPlayerStateClone'
import { isRuntimeLibraryTree } from '@renderer/utils/appRuntimeStateGuards'

type MiniPlayerHostActions = {
  play: () => void
  pause: () => void
  togglePlayPause: () => void
  nextSong: () => void
  previousSong: () => void
  fastForward: () => void
  fastBackward: () => void
  delSong: () => void | Promise<void>
  handleMoveSong: (targetUuid: string) => Promise<void>
  prepareRemoteTransfer: (
    libraryName: LibraryTransferTarget,
    actionMode?: LibraryTransferActionMode
  ) => boolean
  exportTrackWithFolder: (folderPath: string, deleteAfter: boolean) => Promise<void>
  seekSeconds: (seconds: number) => void
  seekPercent: (percent: number) => void
  setVolume: (value: number) => void
  getVolume: () => number
}

export function useMiniPlayerHost(params: {
  runtime: ReturnType<typeof useRuntimeStore>
  audioPlayer: Ref<WebAudioPlayer | null>
  isPlaying: ComputedRef<boolean>
  playerCurrentSeconds: Ref<number>
  playerWaveformDurationSec: ComputedRef<number>
  playerWaveformRenderRevision: Ref<number>
  waveformShow: Ref<boolean>
  actions: MiniPlayerHostActions
}) {
  const session = computed(() => params.runtime.miniPlayerSession)
  const isMiniPlayerOpen = computed(() => session.value.open)

  const resolveIsPlaying = () => params.audioPlayer.value?.isPlaying() ?? params.isPlaying.value

  const buildHostState = (): MiniPlayerHostState => {
    const player = params.audioPlayer.value
    return cloneMiniPlayerHostState({
      song: (params.runtime.playingData.playingSong as ISongInfo | null) || null,
      playingSongListUUID: String(params.runtime.playingData.playingSongListUUID || ''),
      isPlaying: resolveIsPlaying(),
      currentSeconds: params.playerCurrentSeconds.value,
      durationSeconds: params.playerWaveformDurationSec.value,
      volume: params.actions.getVolume(),
      waveformMode: params.runtime.setting.waveformMode === 'full' ? 'full' : 'half',
      compactVisualWaveform: player?.compactVisualWaveformData ?? null,
      pioneerPreviewWaveform: player?.pioneerPreviewWaveformData ?? null
    })
  }

  const publishHostState = () => {
    if (!isMiniPlayerOpen.value) return
    window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.hostState, buildHostState())
  }

  const publishPlayhead = () => {
    if (!isMiniPlayerOpen.value) return
    const payload: MiniPlayerPlayhead = {
      currentSeconds: params.playerCurrentSeconds.value,
      durationSeconds: params.playerWaveformDurationSec.value,
      isPlaying: resolveIsPlaying(),
      volume: params.actions.getVolume()
    }
    window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.playhead, payload)
  }

  const canEnterMiniPlayer = () =>
    params.runtime.mainWindowBrowseMode === 'browser' &&
    !!params.runtime.playingData.playingSong &&
    params.waveformShow.value

  const closeMiniPlayer = async () => {
    if (!isMiniPlayerOpen.value) return
    await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.close)
  }

  const toggleMiniPlayer = async () => {
    if (isMiniPlayerOpen.value) {
      await closeMiniPlayer()
      return
    }
    if (!canEnterMiniPlayer()) return
    await window.electron.ipcRenderer.invoke(MINI_PLAYER_CHANNELS.open)
    publishHostState()
  }

  const handleSession = (_event: unknown, payload: MiniPlayerSession) => {
    params.runtime.miniPlayerSession = {
      open: !!payload?.open,
      alwaysOnTop: payload?.alwaysOnTop !== false
    }
    if (params.runtime.miniPlayerSession.open) {
      publishHostState()
    }
  }

  const handleRendererReady = () => {
    publishHostState()
  }

  const handleCommand = async (_event: unknown, command: MiniPlayerCommand) => {
    if (!command || typeof command !== 'object') return
    switch (command.type) {
      case 'play':
        params.actions.play()
        break
      case 'pause':
        params.actions.pause()
        break
      case 'togglePlayPause':
        params.actions.togglePlayPause()
        break
      case 'next':
        params.actions.nextSong()
        break
      case 'previous':
        params.actions.previousSong()
        break
      case 'fastForward':
        params.actions.fastForward()
        break
      case 'fastBackward':
        params.actions.fastBackward()
        break
      case 'seekSeconds':
        params.actions.seekSeconds(Number(command.seconds) || 0)
        break
      case 'seekPercent':
        params.actions.seekPercent(Number(command.percent) || 0)
        break
      case 'setVolume':
        params.actions.setVolume(Number(command.value) || 0)
        break
      case 'delete':
        await params.actions.delSong()
        break
      case 'export':
        await params.actions.exportTrackWithFolder(command.folderPath, !!command.deleteAfter)
        break
      case 'applyTransfer': {
        try {
          const tree = await window.electron.ipcRenderer.invoke('getLibrary')
          if (isRuntimeLibraryTree(tree)) {
            params.runtime.libraryTree = tree
            params.runtime.oldLibraryTree = JSON.parse(JSON.stringify(tree))
          }
        } catch {}
        if (params.actions.prepareRemoteTransfer(command.libraryName, command.actionMode)) {
          await params.actions.handleMoveSong(command.targetUuid)
        }
        break
      }
      default:
        break
    }
    publishHostState()
  }

  watch(
    () => [
      params.runtime.playingData.playingSong?.filePath,
      params.runtime.playingData.playingSongListUUID,
      params.runtime.playingData.playingSong?.hotCues,
      params.runtime.playingData.playingSong?.memoryCues,
      params.runtime.playingData.playingSong?.songStructure,
      params.runtime.playingData.playingSong?.title,
      params.runtime.playingData.playingSong?.artist,
      params.runtime.playingData.playingSong?.bpm,
      params.runtime.playingData.playingSong?.key,
      params.isPlaying.value,
      params.playerWaveformRenderRevision.value,
      params.runtime.setting.waveformMode,
      params.runtime.setting.themeMode
    ],
    () => publishHostState()
  )

  watch(
    () => params.playerCurrentSeconds.value,
    () => publishPlayhead()
  )

  watch(
    () => params.runtime.playingData.playingSong,
    (song) => {
      if (!isMiniPlayerOpen.value) return
      if (!song) {
        void closeMiniPlayer()
      }
    }
  )

  watch(
    () => params.runtime.mainWindowBrowseMode,
    (mode) => {
      if (mode !== 'browser' && isMiniPlayerOpen.value) {
        void closeMiniPlayer()
      }
    }
  )

  watch(
    () => params.audioPlayer.value,
    (player, _prev, onCleanup) => {
      if (!player) return
      const publishPlayback = (_payload?: unknown) => {
        publishHostState()
        publishPlayhead()
      }
      player.on('play', publishPlayback)
      player.on('pause', publishPlayback)
      onCleanup(() => {
        player.off('play', publishPlayback)
        player.off('pause', publishPlayback)
      })
    },
    { immediate: true }
  )

  onMounted(() => {
    window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.session, handleSession)
    window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.rendererReady, handleRendererReady)
    window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.command, handleCommand)
  })

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.session, handleSession)
    window.electron.ipcRenderer.removeListener(
      MINI_PLAYER_CHANNELS.rendererReady,
      handleRendererReady
    )
    window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.command, handleCommand)
  })

  return {
    isMiniPlayerOpen,
    toggleMiniPlayer
  }
}

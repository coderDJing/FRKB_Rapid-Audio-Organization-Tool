<script setup lang="ts">
import {
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  type ComponentPublicInstance
} from 'vue'
import { MINI_PLAYER_CHANNELS, type MiniPlayerCoverPopupPayload } from '@shared/miniPlayerWindow'
import musicIconAsset from '@renderer/assets/musicIcon.svg?asset'
import PlayerSongInfoCard from '@renderer/pages/modules/songPlayer/PlayerSongInfoCard.vue'

const musicIcon = musicIconAsset
const payload = ref<MiniPlayerCoverPopupPayload | null>(null)
const coverUrl = ref('')
const cardRef = useTemplateRef<ComponentPublicInstance>('cardRef')
let resizeObserver: ResizeObserver | null = null

const reportSize = async () => {
  await nextTick()
  const el = cardRef.value?.$el
  if (!(el instanceof HTMLElement)) return
  const rect = el.getBoundingClientRect()
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupContentSize, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height)
  })
}

const observeCard = () => {
  resizeObserver?.disconnect()
  const el = cardRef.value?.$el
  if (!(el instanceof HTMLElement)) return
  resizeObserver = new ResizeObserver(() => {
    void reportSize()
  })
  resizeObserver.observe(el)
}

const disposeCoverUrl = () => {
  if (coverUrl.value && coverUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(coverUrl.value)
  }
  coverUrl.value = ''
}

const toUint8Array = (raw: unknown): Uint8Array | null => {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (Array.isArray(raw)) return new Uint8Array(raw as number[])
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    return new Uint8Array((raw as { data: number[] }).data)
  }
  return null
}

const loadCover = async (next: MiniPlayerCoverPopupPayload) => {
  const filePath = next.filePath
  const trySize = async (size: number) => {
    const thumb = await window.electron.ipcRenderer.invoke(
      'getSongCoverThumb',
      filePath,
      size,
      next.rootDir || ''
    )
    if (!thumb || payload.value?.filePath !== filePath) return false
    if (thumb.data) {
      const bytes = toUint8Array(thumb.data)
      if (bytes && bytes.length > 0) {
        disposeCoverUrl()
        const cloned = bytes.slice()
        const blob = new Blob([cloned], { type: thumb.format || 'image/jpeg' })
        coverUrl.value = URL.createObjectURL(blob)
        return true
      }
    }
    if (typeof thumb.dataUrl === 'string' && thumb.dataUrl) {
      disposeCoverUrl()
      coverUrl.value = thumb.dataUrl
      return true
    }
    return false
  }
  if (await trySize(512)) return
  if (await trySize(256)) return
  if (payload.value?.filePath === filePath) disposeCoverUrl()
}

const handleState = (_event: unknown, next: MiniPlayerCoverPopupPayload) => {
  const sameFile = payload.value?.filePath === next.filePath
  payload.value = next
  if (!sameFile || !coverUrl.value) void loadCover(next)
  void reportSize()
}

const sendPointer = (inside: boolean) => {
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupPointer, { inside })
}

onMounted(async () => {
  window.electron.ipcRenderer.on(MINI_PLAYER_CHANNELS.coverPopupState, handleState)
  window.electron.ipcRenderer.send(MINI_PLAYER_CHANNELS.coverPopupReady)
  await nextTick()
  observeCard()
  void reportSize()
})

onUnmounted(() => {
  sendPointer(false)
  resizeObserver?.disconnect()
  resizeObserver = null
  window.electron.ipcRenderer.removeListener(MINI_PLAYER_CHANNELS.coverPopupState, handleState)
  disposeCoverUrl()
})
</script>

<template>
  <PlayerSongInfoCard
    ref="cardRef"
    :cover-url="coverUrl"
    :placeholder-src="musicIcon"
    :title-text="payload?.title || ''"
    :artist-text="payload?.artist || ''"
    :album-text="payload?.album || ''"
    :label-text="payload?.label || ''"
    @mouseenter="sendPointer(true)"
    @mouseleave="sendPointer(false)"
  />
</template>

<style scoped lang="scss">
:deep(.songInfo) {
  border-radius: 8px;
  overflow: hidden;
}
</style>

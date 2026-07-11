import { nextTick, onUnmounted, ref } from 'vue'

const LOCATE_FLASH_VISIBLE_MS = 1400

export const useSongLocateFlash = () => {
  const flashRowKey = ref('')
  const flashRowToken = ref(0)
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let flashRafA: number | null = null
  let flashRafB: number | null = null

  const clearFlashSchedule = () => {
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    if (flashRafA !== null) {
      cancelAnimationFrame(flashRafA)
      flashRafA = null
    }
    if (flashRafB !== null) {
      cancelAnimationFrame(flashRafB)
      flashRafB = null
    }
  }

  const triggerFlash = (rowKey: string) => {
    if (!rowKey) return
    clearFlashSchedule()
    flashRowKey.value = ''
    flashRowToken.value += 1
    const flashToken = flashRowToken.value
    void nextTick().then(() => {
      flashRafA = requestAnimationFrame(() => {
        flashRafA = null
        flashRafB = requestAnimationFrame(() => {
          flashRafB = null
          if (flashRowToken.value !== flashToken) return
          flashRowKey.value = rowKey
        })
      })
    })
    flashTimer = setTimeout(() => {
      if (flashRowToken.value === flashToken && flashRowKey.value === rowKey) {
        flashRowKey.value = ''
      }
      flashTimer = null
    }, LOCATE_FLASH_VISIBLE_MS)
  }

  onUnmounted(clearFlashSchedule)

  return {
    flashRowKey,
    flashRowToken,
    triggerFlash
  }
}

import { onMounted, onUnmounted, ref } from 'vue'

export const DIALOG_TRANSITION_DURATION = 240

export function useDialogTransition(duration = DIALOG_TRANSITION_DURATION, autoShow = true) {
  const dialogVisible = ref(false)
  let openFrame: number | null = null
  let closeTimer: number | null = null

  const show = () => {
    if (openFrame !== null) {
      window.cancelAnimationFrame(openFrame)
    }
    openFrame = window.requestAnimationFrame(() => {
      dialogVisible.value = true
      openFrame = null
    })
  }

  const closeWithAnimation = (afterClose: () => void) => {
    if (closeTimer !== null) return
    dialogVisible.value = false
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      afterClose()
    }, duration)
  }

  onMounted(() => {
    if (autoShow) {
      show()
    }
  })

  onUnmounted(() => {
    if (openFrame !== null) {
      window.cancelAnimationFrame(openFrame)
      openFrame = null
    }
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer)
      closeTimer = null
    }
  })

  return {
    dialogVisible,
    closeWithAnimation,
    show
  }
}

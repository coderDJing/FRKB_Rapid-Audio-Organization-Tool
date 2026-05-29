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

  // 注意：关闭动画进行中再次调用时，新的 afterClose 回调会被静默丢弃。
  // 这是故意的设计：快速连续触发关闭是异常操作，丢弃回调比执行多次更安全。
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

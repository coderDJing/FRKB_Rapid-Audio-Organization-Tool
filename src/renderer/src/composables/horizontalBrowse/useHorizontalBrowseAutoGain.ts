import { computed, onMounted, onUnmounted } from 'vue'
import {
  createHorizontalBrowseNativeTransport,
  type HorizontalBrowseDeckKey
} from '@renderer/composables/horizontalBrowse/horizontalBrowseNativeTransport'
import type { HorizontalBrowseTransportDeckSnapshot } from '@shared/horizontalBrowseTransport'

const autoGainTransport = createHorizontalBrowseNativeTransport()
let subscriberCount = 0
let unsubscribeSnapshot: (() => void) | null = null

const startAutoGainSnapshotSync = () => {
  subscriberCount += 1
  if (unsubscribeSnapshot) return
  unsubscribeSnapshot = autoGainTransport.subscribeSnapshot(() => {})
}

const stopAutoGainSnapshotSync = () => {
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount > 0 || !unsubscribeSnapshot) return
  unsubscribeSnapshot()
  unsubscribeSnapshot = null
}

const resolveDeckSnapshot = (
  deck: HorizontalBrowseDeckKey
): HorizontalBrowseTransportDeckSnapshot =>
  deck === 'top' ? autoGainTransport.state.top : autoGainTransport.state.bottom

const resolveAutoGainTitle = (snapshot: HorizontalBrowseTransportDeckSnapshot) => {
  if (!snapshot.autoGainEnabled || snapshot.autoGainStatus === 'off') return '自动增益已关闭'
  if (snapshot.autoGainStatus === 'master') return '自动增益已开启：当前轨道是 Master'
  if (snapshot.autoGainStatus === 'pending') {
    return snapshot.loaded ? '正在分析响度并对齐 Master' : '自动增益已开启：等待加载音频'
  }
  if (snapshot.autoGainStatus === 'unavailable') return '自动增益暂不可用'
  return '自动增益已开启：已对齐当前 Master'
}

export const useHorizontalBrowseAutoGain = (deck: HorizontalBrowseDeckKey) => {
  onMounted(startAutoGainSnapshotSync)
  onUnmounted(stopAutoGainSnapshotSync)

  const autoGainSnapshot = computed(() => resolveDeckSnapshot(deck))
  const autoGainEnabled = computed(() => autoGainSnapshot.value.autoGainEnabled)
  const autoGainStatus = computed(() => autoGainSnapshot.value.autoGainStatus)
  const autoGainTitle = computed(() => resolveAutoGainTitle(autoGainSnapshot.value))

  const toggleAutoGain = () => {
    void autoGainTransport.setAutoGainEnabled(deck, !autoGainEnabled.value)
  }

  return {
    autoGainEnabled,
    autoGainStatus,
    autoGainTitle,
    toggleAutoGain
  }
}

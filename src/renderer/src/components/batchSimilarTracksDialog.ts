import { createVNode, render } from 'vue'
import BatchSimilarTracksDialog from './batchSimilarTracksDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import { mapSimilarTracksError, runSimilarTracksBatch } from '@renderer/utils/similarTracksBatch'
import type { ISongInfo } from 'src/types/globals'
import type { ISimilarTracksBatchResult } from 'src/types/globals'

/**
 * 打开统一的「相似歌曲」对话框。
 * 单首与多首入口都走这里。初始查询只走底部进度条，完成后再弹结果框。
 */
const openBatchSimilarTracksDialog = async (seeds: ISongInfo[]) => {
  let initialResult: ISimilarTracksBatchResult | null = null
  let initialErrorText = ''
  try {
    initialResult = await runSimilarTracksBatch(seeds)
    if (initialResult.canceled) return
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    initialErrorText = mapSimilarTracksError(message)
  }

  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const cleanup = () => {
      render(null, div)
      div.remove()
    }

    const handleClose = () => {
      cleanup()
      resolve()
    }

    const handleRetry = () => {
      cleanup()
      void openBatchSimilarTracksDialog(seeds)
      resolve()
    }

    const vnode = createVNode(BatchSimilarTracksDialog, {
      seeds,
      initialResult,
      initialErrorText,
      onClose: handleClose,
      onRetry: handleRetry
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}

export default openBatchSimilarTracksDialog

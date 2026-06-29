import { createVNode, render } from 'vue'
import BatchSimilarTracksDialog from './batchSimilarTracksDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { ISongInfo } from 'src/types/globals'

/**
 * 打开统一的「相似歌曲」对话框。
 * 单首与多首入口都走这里，多首时自动展示批量进度与来源种子。
 */
export default (seeds: ISongInfo[]) => {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(BatchSimilarTracksDialog, {
      seeds,
      onClose: handleClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}

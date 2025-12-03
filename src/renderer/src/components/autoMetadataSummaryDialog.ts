import { createVNode, render } from 'vue'
import AutoMetadataSummaryDialog from './autoMetadataSummaryDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { IMetadataAutoFillSummary } from 'src/types/globals'

export default (summary: IMetadataAutoFillSummary) => {
  return new Promise<void>((resolve) => {
    const div = document.createElement('div')
    div.setAttribute('class', 'dialog')
    document.body.appendChild(div)

    const handleClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(AutoMetadataSummaryDialog, {
      summary,
      onClose: handleClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}

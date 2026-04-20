import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import ResultDialog from './ResultDialog.vue'
import type { IBatchRenameExecutionResult } from 'src/types/globals'

export default (result: IBatchRenameExecutionResult) =>
  new Promise<void>((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const handleClose = () => {
      render(null, div)
      div.remove()
      resolve()
    }

    const vnode = createVNode(ResultDialog, {
      result,
      onClose: handleClose
    })
    attachAppContext(vnode)
    render(vnode, div)
  })

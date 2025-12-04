import { createVNode, render } from 'vue'
import playerGlobalShortcutDialog from './playerGlobalShortcutDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { PlayerGlobalShortcutAction } from 'src/types/globals'

export default (actionKey: PlayerGlobalShortcutAction) => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)

    const cleanup = () => {
      render(null, div)
      div.remove()
    }

    const confirmCallback = () => {
      cleanup()
      resolve('success')
    }

    const cancelCallback = () => {
      cleanup()
      resolve('cancel')
    }

    const vnode = createVNode(playerGlobalShortcutDialog, {
      actionKey,
      confirmCallback,
      cancelCallback
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}

import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import LibraryStemSeparationDialog from './libraryStemSeparationDialog.vue'

type OpenLibraryStemSeparationDialogArgs = {
  filePath: string
  songTitle?: string
  initialSnapshot?: unknown
}

export default (args: OpenLibraryStemSeparationDialogArgs) => {
  return new Promise<void>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const close = () => {
      render(null, container)
      container.remove()
      resolve()
    }
    const minimize = () => {
      window.dispatchEvent(
        new CustomEvent('library-stem:minimized', {
          detail: { filePath: args.filePath, songTitle: args.songTitle || '' }
        })
      )
      close()
    }
    const vnode = createVNode(LibraryStemSeparationDialog, {
      filePath: args.filePath,
      songTitle: args.songTitle || '',
      initialSnapshot: args.initialSnapshot,
      onClose: close,
      onMinimize: minimize
    })
    attachAppContext(vnode)
    render(vnode, container)
  })
}

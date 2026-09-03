import { createVNode, render } from 'vue'
import JoinDialog from './curatedLibrarySyncJoinDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { CuratedLibrarySyncJoinMode } from '../../../shared/curatedLibrarySync'

export type CuratedLibrarySyncJoinChoice = CuratedLibrarySyncJoinMode | 'cancel'

export default (options: {
  title: string
  lines: string[]
  mergeLabel: string
  cloudWinsLabel: string
  localWinsLabel: string
  cancelLabel: string
}): Promise<CuratedLibrarySyncJoinChoice> => {
  return new Promise((resolve) => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const finish = (value: CuratedLibrarySyncJoinChoice) => {
      render(null, div)
      div.remove()
      resolve(value)
    }
    const vnode = createVNode(JoinDialog, {
      ...options,
      onChoose: (mode: CuratedLibrarySyncJoinMode) => finish(mode),
      onCancel: () => finish('cancel')
    })
    attachAppContext(vnode)
    render(vnode, div)
  })
}

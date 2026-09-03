import { createVNode, render } from 'vue'
import JoinDialog from './curatedLibrarySyncJoinDialog.vue'
import { attachAppContext } from '@renderer/utils/appContext'
import type { CuratedLibrarySyncJoinMode } from '../../../shared/curatedLibrarySync'

export type CuratedLibrarySyncJoinChoice = CuratedLibrarySyncJoinMode | 'cancel'

export default (options: {
  title: string
  intro: string
  localCountLabel: string
  cloudCountLabel: string
  localCount: number
  cloudCount: number
  countUnit: string
  mergeLabel: string
  mergeHint: string
  mergeBadge: string
  cloudWinsLabel: string
  cloudWinsHint: string
  localWinsLabel: string
  localWinsHint: string
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

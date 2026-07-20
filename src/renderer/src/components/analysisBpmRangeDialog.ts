import { createVNode, render } from 'vue'
import { attachAppContext } from '@renderer/utils/appContext'
import AnalysisBpmRangeDialog from './analysisBpmRangeDialog.vue'
import type { AnalysisBpmRangePresetId } from '@shared/analysisBpmRange'

type AnalysisBpmRangeDialogOptions = {
  count: number
  initialRangeId: AnalysisBpmRangePresetId
}

export default (options: AnalysisBpmRangeDialogOptions) =>
  new Promise<AnalysisBpmRangePresetId | null>((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const close = (value: AnalysisBpmRangePresetId | null) => {
      render(null, container)
      container.remove()
      resolve(value)
    }

    const vnode = createVNode(AnalysisBpmRangeDialog, {
      ...options,
      confirmCallback: (value: AnalysisBpmRangePresetId) => close(value),
      cancelCallback: () => close(null)
    })
    attachAppContext(vnode)
    render(vnode, container)
  })

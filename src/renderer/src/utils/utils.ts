import hotkeys from 'hotkeys-js'
import { useRuntimeStore } from '@renderer/stores/runtime'
const setHotkeysScpoe = (scope: string) => {
  const runtime = useRuntimeStore()
  hotkeys.setScope(scope)
  runtime.hotkeysScopesHeap.push(scope)
}

const delHotkeysScope = (scope: string) => {
  const runtime = useRuntimeStore()
  hotkeys.deleteScope(scope)
  const idx = runtime.hotkeysScopesHeap.indexOf(scope)
  if (idx >= 0) runtime.hotkeysScopesHeap.splice(idx, 1)
  const fallback = runtime.hotkeysScopesHeap[runtime.hotkeysScopesHeap.length - 1]
  if (fallback) hotkeys.setScope(fallback)
}

export default {
  setHotkeysScpoe,
  delHotkeysScope
}

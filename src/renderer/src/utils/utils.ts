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
  runtime.hotkeysScopesHeap.splice(runtime.hotkeysScopesHeap.indexOf(scope), 1)
  hotkeys.setScope(runtime.hotkeysScopesHeap[runtime.hotkeysScopesHeap.length - 1])
}
export default {
  setHotkeysScpoe,
  delHotkeysScope
}

import hotkeys from 'hotkeys-js'
import { useRuntimeStore } from '@renderer/stores/runtime'
const setHotkeysScpoe = (scope) => {
  const runtime = useRuntimeStore()
  hotkeys.setScope(scope)
  runtime.hotkeysScopesHeap.push(scope)
  console.log('setHotkeysScpoe', hotkeys.getScope())
}

const delHotkeysScope = (scope) => {
  const runtime = useRuntimeStore()
  hotkeys.deleteScope(scope)
  runtime.hotkeysScopesHeap.splice(runtime.hotkeysScopesHeap.indexOf(scope), 1)
  hotkeys.setScope(runtime.hotkeysScopesHeap[runtime.hotkeysScopesHeap.length - 1])
  console.log('delHotkeysScope', hotkeys.getScope())
}
export default {
  setHotkeysScpoe,
  delHotkeysScope
}

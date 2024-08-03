import hotkeys from 'hotkeys-js'

//hotkeysScopesHeap为runtime.hotkeysScopesHeap
const setHotkeysScpoe = (hotkeysScopesHeap, scope) => {
  hotkeys.setScope(scope)
  hotkeysScopesHeap.push(scope)
  console.log('setHotkeysScpoe', hotkeys.getScope())
}

//hotkeysScopesHeap为runtime.hotkeysScopesHeap
const delHotkeysScope = (hotkeysScopesHeap, scope) => {
  hotkeys.deleteScope(scope)
  hotkeysScopesHeap.pop()
  hotkeys.setScope(hotkeysScopesHeap[hotkeysScopesHeap.length - 1])
  console.log('delHotkeysScope', hotkeys.getScope())
}
export default {
  setHotkeysScpoe,
  delHotkeysScope
}

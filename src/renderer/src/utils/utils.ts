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

export function getCurrentTimeDirName() {
  let now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1
  let day = now.getDate()
  let hour = now.getHours()
  let minute = now.getMinutes()
  let second = now.getSeconds()

  // 格式化为两位数
  let monthStr = month < 10 ? '0' + month : month
  let dayStr = day < 10 ? '0' + day : day
  let hourStr = hour < 10 ? '0' + hour : hour
  let minuteStr = minute < 10 ? '0' + minute : minute
  let secondStr = second < 10 ? '0' + second : second

  return `${year}-${monthStr}-${dayStr}_${hourStr}-${minuteStr}-${secondStr}`
}

export default {
  setHotkeysScpoe,
  delHotkeysScope,
  getCurrentTimeDirName
}

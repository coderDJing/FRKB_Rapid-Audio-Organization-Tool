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

export function getCurrentTimeDirName() {
  let now = new Date()

  let year = now.getFullYear()
  let month = now.getMonth() + 1
  let day = now.getDate()
  let hour = now.getHours()
  let minute = now.getMinutes()

  // 格式化为两位数
  let monthStr = month < 10 ? '0' + month : month
  let dayStr = day < 10 ? '0' + day : day
  let hourStr = hour < 10 ? '0' + hour : hour
  let minuteStr = minute < 10 ? '0' + minute : minute
  // 目录名按分钟聚合：同一分钟内的删除操作归入同一文件夹
  return `${year}-${monthStr}-${dayStr}_${hourStr}-${minuteStr}`
}

export default {
  setHotkeysScpoe,
  delHotkeysScope,
  getCurrentTimeDirName
}

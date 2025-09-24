import { app } from 'electron'
import fs = require('fs-extra')
import store from '../store'
import databaseInitWindow from '../window/databaseInitWindow'
import mainWindow from '../window/mainWindow'
import { initDatabaseStructure } from '../initDatabase'
import { ensureManifestForLegacy, writeManifest } from '../databaseManifest'
import { healAndPrepare, loadList } from '../fingerprintStore'

// 幂等准备数据库并打开主窗口；异常或缺少数据库则进入初始化窗口
export const prepareAndOpenMainWindow = async (): Promise<void> => {
  // 未配置数据库路径：进入初始化
  if (!store.settingConfig.databaseUrl) {
    databaseInitWindow.createWindow()
    return
  }

  // 若数据库根路径不存在：进入初始化且提示
  try {
    const exists = fs.pathExistsSync(store.settingConfig.databaseUrl)
    if (!exists) {
      databaseInitWindow.createWindow({ needErrorHint: true })
      return
    }
  } catch (_e) {
    databaseInitWindow.createWindow({ needErrorHint: true })
    return
  }

  try {
    // 幂等创建/修复结构
    await initDatabaseStructure(store.settingConfig.databaseUrl, { createSamples: false })
    // Manifest：旧库静默生成或补齐
    try {
      const legacy = await ensureManifestForLegacy(
        store.settingConfig.databaseUrl,
        app.getVersion()
      )
      if (!legacy) {
        await writeManifest(store.settingConfig.databaseUrl, app.getVersion())
      }
    } catch {}
    // 指纹仓：修复并加载
    await healAndPrepare()
    const list = await loadList()
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = Array.isArray(list) ? list : []
    // 创建主窗口
    mainWindow.createWindow()
  } catch (_e) {
    databaseInitWindow.createWindow({ needErrorHint: true })
  }
}

export default {
  prepareAndOpenMainWindow
}

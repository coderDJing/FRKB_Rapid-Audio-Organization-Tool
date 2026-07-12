import { app } from 'electron'
import fs = require('fs-extra')
import path = require('path')
import store from '../store'
import databaseInitWindow from '../window/databaseInitWindow'
import mainWindow from '../window/mainWindow'
import { initDatabaseStructure } from '../initDatabase'
import {
  ensureManifestForLegacy,
  writeManifest,
  ensureManifestMinVersion
} from '../databaseManifest'
import { loadList } from '../fingerprintStore'
import { ensureLegacyMigration } from '../libraryMigration'
import { recoverIncompleteLibraryMerges } from '../services/libraryMerge'

const isConfiguredDevDatabase = (): boolean => {
  if (app.isPackaged) return false
  const configured = String(process.env.FRKB_DEV_DATABASE_URL || '').trim()
  const current = String(store.settingConfig.databaseUrl || '').trim()
  if (!configured || !current) return false
  const resolvedConfigured = path.resolve(configured)
  const resolvedCurrent = path.resolve(current)
  return process.platform === 'win32'
    ? resolvedConfigured.toLocaleLowerCase() === resolvedCurrent.toLocaleLowerCase()
    : resolvedConfigured === resolvedCurrent
}

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
    // 合并恢复必须先于任何 schema 初始化、树同步或后台任务；否则未提交任务的
    // SQLite 提交标记和已提升文件可能先被普通启动流程干扰。
    const databaseFilePath = path.join(store.settingConfig.databaseUrl, 'FRKB.database.sqlite')
    if (await fs.pathExists(databaseFilePath)) {
      await recoverIncompleteLibraryMerges(store.settingConfig.databaseUrl)
    }
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
      await ensureManifestMinVersion(store.settingConfig.databaseUrl, app.getVersion())
    } catch {}
    const proceed = await ensureLegacyMigration(store.settingConfig.databaseUrl)
    if (!proceed) return
    // 根据设置的模式加载对应列表
    const mode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
    const list = await loadList(mode)
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = Array.isArray(list) ? list : []
    // 创建主窗口
    mainWindow.createWindow()
  } catch (error) {
    if (isConfiguredDevDatabase()) {
      console.error(
        `[frkb-dev] Configured database failed the library merge contract check: ${
          error instanceof Error ? error.message : String(error || 'unknown error')
        }`
      )
      app.exit(1)
      return
    }
    databaseInitWindow.createWindow({ needErrorHint: true })
  }
}

import { app } from 'electron'
import fs = require('fs-extra')
import path = require('path')
import store from '../store'
import databaseInitWindow from '../window/databaseInitWindow'
import databaseSchemaMigrationWindow from '../window/databaseSchemaMigrationWindow'
import mainWindow from '../window/mainWindow'
import startupWindow from '../window/startupWindow'
import { initDatabaseStructure } from '../initDatabase'
import {
  ensureManifestForLegacy,
  writeManifest,
  ensureManifestMinVersion
} from '../databaseManifest'
import { loadList } from '../fingerprintStore'
import { ensureLegacyMigration } from '../libraryMigration'
import { recoverIncompleteLibraryMerges } from '../services/libraryMerge'
import {
  assertExistingDatabaseSchemaSupported,
  getLibraryDbPath,
  isDatabaseSchemaVersionError
} from '../libraryDb'
import { migrateLibrarySchemaV35ToV36 } from '../librarySchemaV36Migration'
import { migrateLibrarySchemaToV38 } from '../librarySchemaV37Migration'

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
    startupWindow.setStage('selecting-library')
    databaseInitWindow.createWindow()
    startupWindow.closeWindow()
    return
  }

  // 已配置的库必须同时保留根目录和 library 目录。这里是只读边界：
  // 不允许把用户手动删除的库路径补建成新的空库。
  try {
    startupWindow.setStage('checking-library')
    const databaseRoot = store.settingConfig.databaseUrl
    const libraryRoot = path.join(databaseRoot, 'library')
    const rootExists = fs.pathExistsSync(databaseRoot)
    const libraryExists = fs.pathExistsSync(libraryRoot)
    if (!rootExists || !libraryExists) {
      startupWindow.setStage('selecting-library')
      databaseInitWindow.createWindow({ needErrorHint: true })
      startupWindow.closeWindow()
      return
    }
  } catch (_e) {
    startupWindow.setStage('selecting-library')
    databaseInitWindow.createWindow({ needErrorHint: true })
    startupWindow.closeWindow()
    return
  }

  try {
    // 合并恢复必须先于任何 schema 初始化、树同步或后台任务；否则未提交任务的
    // SQLite 提交标记和已提升文件可能先被普通启动流程干扰。
    const databaseFilePath = getLibraryDbPath(store.settingConfig.databaseUrl)
    if (await fs.pathExists(databaseFilePath)) {
      startupWindow.setStage('recovering-library')
      let databaseVersion = assertExistingDatabaseSchemaSupported(databaseFilePath)
      if (databaseVersion === 35) {
        databaseSchemaMigrationWindow.createWindow()
        // 先建立接替窗口，再销毁启动窗口；否则会短暂触发 window-all-closed 并退出应用。
        startupWindow.closeWindow()
        await migrateLibrarySchemaV35ToV36(databaseFilePath, {
          onProgress: databaseSchemaMigrationWindow.setSchemaMigrationProgress
        })
        databaseVersion = assertExistingDatabaseSchemaSupported(databaseFilePath)
      }
      if (databaseVersion === 36 || databaseVersion === 37) {
        databaseSchemaMigrationWindow.createWindow()
        // 同上，schema 升级窗口必须先存在，避免启动窗口关闭时误触发全局退出。
        startupWindow.closeWindow()
        await migrateLibrarySchemaToV38(databaseFilePath, {
          onProgress: databaseSchemaMigrationWindow.setSchemaMigrationProgress
        })
      }
      await recoverIncompleteLibraryMerges(store.settingConfig.databaseUrl)
    }
    // 幂等创建/修复结构
    startupWindow.setStage('preparing-library')
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
    if (!proceed) {
      startupWindow.closeWindow()
      return
    }
    // 根据设置的模式加载对应列表
    startupWindow.setStage('loading-fingerprints')
    const mode = store.settingConfig?.fingerprintMode === 'file' ? 'file' : 'pcm'
    const list = await loadList(mode)
    store.databaseDir = store.settingConfig.databaseUrl
    store.songFingerprintList = Array.isArray(list) ? list : []
    // 创建主窗口
    startupWindow.setStage('opening-main-window')
    databaseSchemaMigrationWindow.close()
    mainWindow.createWindow()
    databaseInitWindow.instance?.close()
  } catch (error) {
    if (databaseSchemaMigrationWindow.hasFailedMigration()) return
    databaseSchemaMigrationWindow.close()
    if (isConfiguredDevDatabase()) {
      console.error(
        `[frkb-dev] Configured database failed the library merge contract check: ${
          error instanceof Error ? error.message : String(error || 'unknown error')
        }`
      )
      startupWindow.closeWindow()
      app.exit(1)
      return
    }
    startupWindow.setStage('selecting-library')
    if (isDatabaseSchemaVersionError(error)) {
      databaseInitWindow.createWindow({
        errorHint: {
          kind: 'schema-too-new',
          databaseUrl: store.settingConfig.databaseUrl,
          databaseVersion: error.databaseVersion,
          maximumSupportedVersion: error.maximumSupportedVersion
        }
      })
      startupWindow.closeWindow()
      return
    }
    databaseInitWindow.createWindow({ needErrorHint: true })
    startupWindow.closeWindow()
  }
}

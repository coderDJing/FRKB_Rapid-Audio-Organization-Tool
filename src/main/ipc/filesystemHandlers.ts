import { ipcMain, dialog, app } from 'electron'
import os = require('os')
import path = require('path')
import fs = require('fs-extra')
import { execFile } from 'child_process'
import { log } from '../log'
import url from '../url'
import {
  readManifestFile,
  MANIFEST_FILE_NAME,
  looksLikeLegacyStructure,
  isManifestCompatible
} from '../databaseManifest'
import store from '../store'
import { mapRendererPathToFsPath, getCoreFsDirName } from '../utils'

export function registerFilesystemHandlers() {
  ipcMain.handle('select-folder', async (_event, multiSelections: boolean = true) => {
    const result = await dialog.showOpenDialog({
      properties: multiSelections ? ['openDirectory', 'multiSelections'] : ['openDirectory']
    })
    if (result.canceled) {
      return null
    }
    return result.filePaths
  })

  ipcMain.handle('get-user-home', async () => {
    return os.homedir()
  })

  ipcMain.handle('get-drives', async () => {
    try {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)

      if (process.platform === 'win32') {
        try {
          const { stdout: psStdout } = await execAsync(
            'powershell -command "Get-WmiObject Win32_LogicalDisk | Select-Object DeviceID, Size, FreeSpace | ConvertTo-Json"'
          )
          const drivesData = JSON.parse(psStdout)
          const drives = drivesData.map((drive: any) => ({
            name: drive.DeviceID,
            path: drive.DeviceID,
            type: 'drive',
            size: parseInt(drive.Size) || 0,
            freeSpace: parseInt(drive.FreeSpace) || 0
          }))
          return drives.filter((drive: any) => drive.name)
        } catch (psError) {
          log.warn('PowerShell failed, falling back to wmic:', psError)
          const { stdout } = await execAsync('wmic logicaldisk get name,size,freespace')
          const lines = stdout.split('\n').slice(1)
          const drives = lines
            .filter((line: string) => line.trim() && /^[A-Z]:\s+\d+\s+\d+$/.test(line.trim()))
            .map((line: string) => {
              const parts = line.trim().split(/\s+/)
              const name = parts[0] || ''
              const sizeStr = parts[1] || '0'
              const freeSpaceStr = parts[2] || '0'

              return {
                name: name,
                path: name,
                type: 'drive',
                size: parseInt(sizeStr) || 0,
                freeSpace: parseInt(freeSpaceStr) || 0
              }
            })
            .filter((drive: any) => drive.name)
          return drives
        }
      } else if (process.platform === 'darwin') {
        const volumes = await fs.readdir('/Volumes')
        const drives = volumes.map((volume) => ({
          name: volume,
          path: `/Volumes/${volume}`,
          type: 'drive'
        }))
        return drives
      } else {
        const { stdout } = await execAsync('lsblk -o NAME,MOUNTPOINT -n -l')
        const lines: string[] = stdout.split('\n')
        const drives = lines
          .filter((line: string) => line.trim() && line.includes('/'))
          .map((line: string) => {
            const parts = line.trim().split(/\s+/)
            return {
              name: parts[0],
              path: parts[1],
              type: 'drive'
            }
          })
        return drives
      }
    } catch (wmicError) {
      log.error('Drive detection failed:', wmicError)
      return []
    }
  })

  ipcMain.handle('read-directory', async (_event, dirPath: string) => {
    try {
      let normalizedPath: string
      if (dirPath.match(/^[A-Z]:$/i)) {
        normalizedPath = dirPath + '/'
      } else {
        normalizedPath = path.resolve(dirPath).replace(/\\/g, '/')
      }

      const items = await fs.readdir(normalizedPath, { withFileTypes: true })
      const result = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(normalizedPath, item.name)
          let size = 0
          if (item.isFile()) {
            try {
              const stats = await fs.stat(itemPath)
              size = stats.size
            } catch {
              size = 0
            }
          }
          return {
            name: item.name,
            path: itemPath,
            isDirectory: item.isDirectory(),
            isFile: item.isFile(),
            size
          }
        })
      )
      return result
    } catch (error) {
      throw new Error(`无法读取目录 ${dirPath}: ${error}`)
    }
  })

  ipcMain.handle('select-existing-database-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'FRKB.database', extensions: ['frkbdb'] }]
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    try {
      if (path.basename(filePath) !== MANIFEST_FILE_NAME) {
        return 'error'
      }
      const manifest = await readManifestFile(filePath)
      const appVersion = app.getVersion()
      if (!isManifestCompatible(manifest, appVersion)) {
        return {
          error: 'incompatible',
          minAppVersion: manifest.minAppVersion,
          appVersion
        }
      }
      return { filePath, rootDir: path.dirname(filePath), fileName: MANIFEST_FILE_NAME }
    } catch {
      return 'error'
    }
  })

  ipcMain.handle('check-database-manifest-exists', async (_e, dirPath: string) => {
    try {
      const target = path.join(dirPath, MANIFEST_FILE_NAME)
      return await fs.pathExists(target)
    } catch {
      return false
    }
  })

  ipcMain.handle('probe-database-dir', async (_e, dirPath: string) => {
    try {
      const manifestPath = path.join(dirPath, MANIFEST_FILE_NAME)
      const hasManifest = await fs.pathExists(manifestPath)
      let isEmpty = false
      const exists = await fs.pathExists(dirPath)
      if (!exists) {
        return { hasManifest: false, isLegacy: false, isEmpty: true }
      }
      try {
        const items = await fs.readdir(dirPath)
        isEmpty = items.length === 0
      } catch {}
      const isLegacy = hasManifest ? false : await looksLikeLegacyStructure(dirPath)
      return { hasManifest, isLegacy, isEmpty }
    } catch {
      return { hasManifest: false, isLegacy: false, isEmpty: false }
    }
  })

  ipcMain.handle('find-db-root-upwards', async (_e, startDir: string) => {
    try {
      let current = startDir
      for (let i = 0; i < 30; i++) {
        const manifestPath = path.join(current, MANIFEST_FILE_NAME)
        if (await fs.pathExists(manifestPath)) {
          return current
        }
        const parent = path.dirname(current)
        if (!parent || parent === current) break
        current = parent
      }
      return null
    } catch {
      return null
    }
  })

  ipcMain.handle('get-windows-hide-ext', async () => {
    if (process.platform !== 'win32') return false
    return await new Promise<boolean>((resolve) => {
      execFile(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
          '/v',
          'HideFileExt'
        ],
        { windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(false)
          const match = stdout.match(/HideFileExt\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
          if (!match) return resolve(false)
          const val = parseInt(match[1], 16)
          resolve(val === 1)
        }
      )
    })
  })

  ipcMain.handle('select-songFingerprintFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled) {
      return null
    }
    try {
      const filePath = result.filePaths[0]
      const json = await fs.readJSON(filePath)
      if (Array.isArray(json) && json.every((item) => typeof item === 'string')) {
        return [filePath]
      }
      return 'error'
    } catch {
      return 'error'
    }
  })

  ipcMain.on('layoutConfigChanged', (_e, layoutConfig) => {
    fs.outputJson(url.layoutConfigFileUrl, JSON.parse(layoutConfig))
  })
}

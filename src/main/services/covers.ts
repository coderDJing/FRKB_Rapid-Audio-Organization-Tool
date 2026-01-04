import path = require('path')
import fs = require('fs-extra')
import { mapRendererPathToFsPath, operateHiddenFile } from '../utils'
import store from '../store'
import * as LibraryCacheDb from '../libraryCacheDb'

export async function getSongCover(
  filePath: string
): Promise<{ format: string; data: Buffer } | null> {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)
    let cover = mm.selectCover(metadata.common.picture)
    if (!cover) {
      const fsStat = await fs.stat(filePath)
      const buffer = await fs.readFile(filePath)
      const arr = await mm.parseBuffer(buffer, {
        size: fsStat.size
      })
      cover = mm.selectCover(arr.common.picture)
    }
    if (!cover) return null
    return { format: cover.format, data: Buffer.from(cover.data as any) }
  } catch {
    return null
  }
}

const mimeFromExt = (ext: string) =>
  ext === '.png'
    ? 'image/png'
    : ext === '.webp'
      ? 'image/webp'
      : ext === '.gif'
        ? 'image/gif'
        : ext === '.bmp'
          ? 'image/bmp'
          : 'image/jpeg'
export const extFromMime = (mime: string) => {
  const lower = (mime || '').toLowerCase()
  if (lower.includes('png')) return '.png'
  if (lower.includes('webp')) return '.webp'
  if (lower.includes('gif')) return '.gif'
  if (lower.includes('bmp')) return '.bmp'
  return '.jpg'
}

export async function getSongCoverThumb(
  filePath: string,
  size: number = 48,
  listRootDir?: string | null
): Promise<{ format: string; data: Buffer; dataUrl: string } | null> {
  try {
    const mm = await import('music-metadata')
    const crypto = await import('crypto')

    // 解析 listRootDir 为绝对路径（允许 library 相对路径）
    let resolvedRoot: string | null = null
    if (listRootDir && typeof listRootDir === 'string' && listRootDir.length > 0) {
      let input = listRootDir
      if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
      if (path.isAbsolute(input)) {
        resolvedRoot = input
      } else {
        const mapped = mapRendererPathToFsPath(input)
        resolvedRoot = path.join(store.databaseDir, mapped)
      }
    }
    let useDiskCache = !!(
      resolvedRoot &&
      path.isAbsolute(resolvedRoot) &&
      (await fs.pathExists(resolvedRoot))
    )
    let coversDir: string | null = useDiskCache
      ? path.join(resolvedRoot as string, '.frkb_covers')
      : null
    let dbEntry: { hash: string; ext: string } | null = null
    if (useDiskCache && coversDir) {
      const listRoot = resolvedRoot as string
      const entry = await LibraryCacheDb.loadCoverIndexEntry(listRoot, filePath)
      if (entry === undefined) {
        useDiskCache = false
        coversDir = null
      } else {
        dbEntry = entry
      }
    }
    if (useDiskCache && coversDir) {
      await fs.ensureDir(coversDir)
      await operateHiddenFile(coversDir, async () => {})
    }

    // 命中索引则直接返回
    if (useDiskCache && coversDir && dbEntry) {
      const ext = dbEntry.ext || '.jpg'
      const p = path.join(coversDir, `${dbEntry.hash}${ext}`)
      if (await fs.pathExists(p)) {
        const st0 = await fs.stat(p)
        if (st0.size > 0) {
          const data = await fs.readFile(p)
          const mime = mimeFromExt(ext)
          const dataUrl = `data:${mime};base64,${data.toString('base64')}`
          return { format: mime, data, dataUrl }
        }
      }
    }

    // 解析嵌入封面
    let format = 'image/jpeg'
    let data: Buffer | null = null
    try {
      const metadata = await mm.parseFile(filePath)
      const cover = mm.selectCover(metadata.common.picture)
      if (!cover) return null
      format = cover.format || 'image/jpeg'
      const raw: any = cover.data as any
      if (Buffer.isBuffer(raw)) data = raw
      else if (raw instanceof Uint8Array) data = Buffer.from(raw)
      else if (Array.isArray(raw)) data = Buffer.from(raw)
      else if (raw && raw.buffer && typeof raw.byteLength === 'number') {
        try {
          const view = new Uint8Array(
            raw.buffer,
            (raw as any).byteOffset || 0,
            (raw as any).byteLength
          )
          data = Buffer.from(view)
        } catch {
          data = null
        }
      } else if (raw && (raw as any).data && Array.isArray((raw as any).data)) {
        data = Buffer.from((raw as any).data)
      } else {
        data = null
      }
    } catch {
      return null
    }
    if (!data || data.length === 0) return null

    const imageHash = (await crypto).createHash('sha1').update(data).digest('hex')
    const ext = extFromMime(format)
    const mime = format || 'image/jpeg'
    const dataUrl = `data:${mime};base64,${data.toString('base64')}`

    if (useDiskCache && coversDir) {
      const targetPath = path.join(coversDir, `${imageHash}${ext}`)
      const tmp = `${targetPath}.tmp_${Date.now()}`
      try {
        await fs.writeFile(tmp, data)
        await fs.move(tmp, targetPath, { overwrite: true })
        await operateHiddenFile(targetPath, async () => {})
        const listRoot = resolvedRoot as string
        const saved = await LibraryCacheDb.upsertCoverIndexEntry(listRoot, filePath, imageHash, ext)
        if (!saved) {
          return { format: mime, data, dataUrl }
        }
      } catch {
      } finally {
        try {
          if (await fs.pathExists(tmp)) await fs.remove(tmp)
        } catch {}
      }
    }
    return { format: mime, data, dataUrl }
  } catch {
    return null
  }
}

export async function sweepSongListCovers(
  listRootDir: string,
  currentFilePaths: string[]
): Promise<{ removed: number }> {
  try {
    if (!listRootDir || typeof listRootDir !== 'string') return { removed: 0 }
    let input = listRootDir
    if (process.platform === 'win32' && /^\//.test(input)) input = input.replace(/^\/+/, '')
    const mapped = path.isAbsolute(input) ? input : mapRendererPathToFsPath(input)
    const resolvedRoot = path.isAbsolute(mapped) ? mapped : path.join(store.databaseDir, mapped)
    const coversDir = path.join(resolvedRoot, '.frkb_covers')
    if (!(await fs.pathExists(coversDir))) return { removed: 0 }

    const dbEntries = await LibraryCacheDb.loadCoverIndexEntries(resolvedRoot)
    if (dbEntries) {
      const alive = new Set(currentFilePaths || [])
      const hashCounts = new Map<string, number>()
      const hashToExt = new Map<string, string>()
      for (const entry of dbEntries) {
        hashCounts.set(entry.hash, (hashCounts.get(entry.hash) || 0) + 1)
        if (!hashToExt.has(entry.hash)) {
          hashToExt.set(entry.hash, entry.ext || '.jpg')
        }
      }
      const toRemove: string[] = []
      for (const entry of dbEntries) {
        if (!alive.has(entry.filePath)) {
          toRemove.push(entry.filePath)
          hashCounts.set(entry.hash, (hashCounts.get(entry.hash) || 1) - 1)
        }
      }
      if (toRemove.length > 0) {
        await LibraryCacheDb.removeCoverIndexEntries(resolvedRoot, toRemove)
      }
      let removed = 0
      const liveHashes = new Set<string>()
      for (const [hash, count] of hashCounts.entries()) {
        if (count > 0) {
          liveHashes.add(hash)
          continue
        }
        const ext = hashToExt.get(hash) || '.jpg'
        const p = path.join(coversDir, `${hash}${ext}`)
        try {
          if (await fs.pathExists(p)) {
            await fs.remove(p)
            removed++
          }
        } catch {}
      }
      try {
        const entries = await fs.readdir(coversDir)
        const imgRegex = /^[a-f0-9]{40}\.(jpg|png|webp|gif|bmp)$/i
        for (const name of entries) {
          const full = path.join(coversDir, name)
          if (name.includes('.tmp_')) {
            try {
              await fs.remove(full)
            } catch {}
            continue
          }
          if (!imgRegex.test(name)) continue
          const hash = name.slice(0, 40).toLowerCase()
          if (!liveHashes.has(hash)) {
            try {
              await fs.remove(full)
              removed++
            } catch {}
          }
        }
      } catch {}
      return { removed }
    }

    return { removed: 0 }
  } catch {
    return { removed: 0 }
  }
}

export default {
  getSongCover,
  getSongCoverThumb,
  sweepSongListCovers
}

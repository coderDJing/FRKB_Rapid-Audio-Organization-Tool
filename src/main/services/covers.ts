import path = require('path')
import fs = require('fs-extra')
import { mapRendererPathToFsPath, operateHiddenFile } from '../utils'
import store from '../store'

export async function getSongCover(
  filePath: string
): Promise<{ format: string; data: Buffer } | null> {
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(filePath)
    const cover = mm.selectCover(metadata.common.picture)
    if (!cover) return null
    return { format: cover.format, data: Buffer.from(cover.data as any) }
  } catch {
    return null
  }
}

type CoverIndex = {
  fileToHash: Record<string, string>
  hashToFiles: Record<string, string[]>
  hashToExt: Record<string, string>
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
const extFromMime = (mime: string) => {
  const lower = (mime || '').toLowerCase()
  if (lower.includes('png')) return '.png'
  if (lower.includes('webp')) return '.webp'
  if (lower.includes('gif')) return '.gif'
  if (lower.includes('bmp')) return '.bmp'
  return '.jpg'
}

const ensureArrHas = (arr: string[], v: string) => {
  if (arr.indexOf(v) === -1) arr.push(v)
  return arr
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
    const useDiskCache = !!(
      resolvedRoot &&
      path.isAbsolute(resolvedRoot) &&
      (await fs.pathExists(resolvedRoot))
    )
    const coversDir = useDiskCache ? path.join(resolvedRoot as string, '.frkb_covers') : null
    if (useDiskCache && coversDir) {
      await fs.ensureDir(coversDir)
      await operateHiddenFile(coversDir, async () => {})
    }

    const indexPath = useDiskCache && coversDir ? path.join(coversDir, '.index.json') : null
    const loadIndex = async (): Promise<CoverIndex> => {
      if (!indexPath) return { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
      try {
        const json = await fs.readJSON(indexPath)
        return {
          fileToHash: json?.fileToHash || {},
          hashToFiles: json?.hashToFiles || {},
          hashToExt: json?.hashToExt || {}
        }
      } catch {
        return { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
      }
    }
    const saveIndex = async (idx: CoverIndex) => {
      if (!indexPath) return
      try {
        await fs.writeJSON(indexPath, idx)
      } catch {}
    }

    // 命中索引则直接返回
    if (useDiskCache && coversDir) {
      const idx = await loadIndex()
      const known = idx.fileToHash[filePath]
      if (known) {
        const ext = idx.hashToExt[known] || '.jpg'
        const p = path.join(coversDir, `${known}${ext}`)
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
        const idx = await loadIndex()
        idx.fileToHash[filePath] = imageHash
        idx.hashToFiles[imageHash] = ensureArrHas(idx.hashToFiles[imageHash] || [], filePath)
        idx.hashToExt[imageHash] = ext
        await saveIndex(idx)
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

    const indexPath = path.join(coversDir, '.index.json')
    let idx: any = { fileToHash: {}, hashToFiles: {}, hashToExt: {} }
    try {
      const json = await fs.readJSON(indexPath)
      idx.fileToHash = json?.fileToHash || {}
      idx.hashToFiles = json?.hashToFiles || {}
      idx.hashToExt = json?.hashToExt || {}
    } catch {}

    const alive = new Set(currentFilePaths || [])
    for (const fp of Object.keys(idx.fileToHash)) {
      if (!alive.has(fp)) {
        const h = idx.fileToHash[fp]
        delete idx.fileToHash[fp]
        if (Array.isArray(idx.hashToFiles[h])) {
          idx.hashToFiles[h] = idx.hashToFiles[h].filter((x: string) => x !== fp)
        }
      }
    }
    let removed = 0
    const liveHashes = new Set<string>()
    for (const h of Object.keys(idx.hashToFiles)) {
      const arr = idx.hashToFiles[h]
      if (Array.isArray(arr) && arr.length > 0) liveHashes.add(h)
    }
    for (const h of Object.keys(idx.hashToFiles)) {
      const arr = idx.hashToFiles[h]
      if (!Array.isArray(arr) || arr.length === 0) {
        const ext = idx.hashToExt[h] || '.jpg'
        const p = path.join(coversDir, `${h}${ext}`)
        try {
          if (await fs.pathExists(p)) {
            await fs.remove(p)
            removed++
          }
        } catch {}
        delete idx.hashToFiles[h]
        delete idx.hashToExt[h]
      }
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

    await fs.writeJSON(indexPath, idx)
    return { removed }
  } catch {
    return { removed: 0 }
  }
}

export default {
  getSongCover,
  getSongCoverThumb,
  sweepSongListCovers
}

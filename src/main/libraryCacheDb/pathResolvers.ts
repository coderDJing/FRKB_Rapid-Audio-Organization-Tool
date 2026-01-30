import path = require('path')
import type { ISongInfo } from '../../types/globals'
import store from '../store'

export function toNumber(value: any): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

export function normalizeRoot(value: any): string {
  let normalized = path.normalize(String(value || ''))
  normalized = normalized.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

export function normalizePath(value: any): string {
  if (!value) return ''
  let normalized = path.resolve(String(value))
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return normalized
}

type CacheRootResolved = {
  key: string
  keyRaw?: string
  abs: string
  legacyAbs?: string
  isRelativeKey: boolean
}

type CacheFileResolved = {
  key: string
  keyRaw?: string
  abs: string
  legacyAbs?: string
  isRelativeKey: boolean
}

function getDatabaseRoot(): string {
  const root = store.databaseDir || store.settingConfig?.databaseUrl || ''
  return typeof root === 'string' ? root : ''
}

export function getDatabaseRootAbs(): string {
  const root = getDatabaseRoot()
  return root ? path.resolve(root) : ''
}

export function isUnderPath(parentPath: string, targetPath: string): boolean {
  const parent = normalizePath(parentPath)
  const target = normalizePath(targetPath)
  if (!parent || !target) return false
  return target === parent || target.startsWith(parent + path.sep)
}

export function extractLibraryRelative(absPath: string): string | null {
  if (!absPath) return null
  const normalized = path.normalize(absPath)
  const parts = normalized.split(path.sep).filter((part) => part.length > 0)
  const idx = parts.findIndex((part) => part.toLowerCase() === 'library')
  if (idx < 0) return null
  return parts.slice(idx).join(path.sep)
}

export function resolveListRootInput(listRoot: string): CacheRootResolved | null {
  if (!listRoot) return null
  const raw = String(listRoot)
  const base = getDatabaseRootAbs()
  const isAbs = path.isAbsolute(raw)
  let abs = ''
  let keyRaw = ''
  let key = ''
  let legacyAbs: string | undefined
  let isRelativeKey = false
  if (isAbs) {
    abs = path.resolve(raw)
    legacyAbs = raw
    if (base && isUnderPath(base, abs)) {
      keyRaw = path.relative(base, abs)
      key = normalizeRoot(keyRaw)
      isRelativeKey = true
    } else {
      const relFromLibrary = extractLibraryRelative(abs)
      if (relFromLibrary) {
        keyRaw = relFromLibrary
        key = normalizeRoot(relFromLibrary)
        isRelativeKey = true
      } else {
        key = normalizeRoot(abs)
      }
    }
  } else {
    keyRaw = raw
    key = normalizeRoot(raw)
    isRelativeKey = true
    if (base) {
      abs = path.join(base, raw)
      legacyAbs = abs
    }
  }
  if (!key) return null
  return {
    key,
    keyRaw: keyRaw && keyRaw !== key ? keyRaw : undefined,
    abs,
    legacyAbs,
    isRelativeKey
  }
}

export function resolveFilePathInput(
  listRootAbs: string,
  filePath: string
): CacheFileResolved | null {
  if (!filePath) return null
  const raw = String(filePath)
  const isAbs = path.isAbsolute(raw)
  let abs = ''
  let keyRaw = ''
  let key = ''
  let legacyAbs: string | undefined
  let isRelativeKey = false
  if (isAbs) {
    abs = path.resolve(raw)
    legacyAbs = raw
    if (listRootAbs && isUnderPath(listRootAbs, abs)) {
      keyRaw = path.relative(listRootAbs, abs)
      key = normalizeRoot(keyRaw)
      isRelativeKey = true
    } else {
      key = normalizeRoot(abs)
    }
  } else {
    keyRaw = raw
    key = normalizeRoot(raw)
    isRelativeKey = true
    if (listRootAbs) {
      abs = path.join(listRootAbs, raw)
      legacyAbs = abs
    }
  }
  if (!key) return null
  return {
    key,
    keyRaw: keyRaw && keyRaw !== key ? keyRaw : undefined,
    abs,
    legacyAbs,
    isRelativeKey
  }
}

export function resolveAbsoluteListRoot(listRootKey: string): string {
  if (!listRootKey) return ''
  if (path.isAbsolute(listRootKey)) return path.resolve(listRootKey)
  const base = getDatabaseRootAbs()
  if (!base) return path.resolve(listRootKey)
  return path.join(base, listRootKey)
}

export function resolveAbsoluteFilePath(listRootKey: string, fileKey: string): string {
  if (!fileKey) return ''
  if (path.isAbsolute(fileKey)) return path.resolve(fileKey)
  const listRootAbs = resolveAbsoluteListRoot(listRootKey)
  if (!listRootAbs) return path.resolve(fileKey)
  return path.join(listRootAbs, fileKey)
}

export function normalizeInfoJsonFilePath(raw: any, absFilePath: string): string {
  try {
    const info = JSON.parse(String(raw)) as ISongInfo
    if (info && typeof info === 'object') {
      info.filePath = absFilePath
      return JSON.stringify(info)
    }
  } catch {}
  return typeof raw === 'string' ? raw : String(raw || '')
}

export function resolveCacheListRootAbs(listRoot: string): string | null {
  if (!listRoot) return null
  const resolved = resolveListRootInput(listRoot)
  if (!resolved) return null
  if (resolved.isRelativeKey) {
    const abs = resolveAbsoluteListRoot(resolved.key)
    return abs || resolved.abs || null
  }
  return resolved.abs || resolveAbsoluteListRoot(resolved.key)
}

export function resolveCacheFilePath(listRoot: string, filePath: string): string | null {
  if (!listRoot || !filePath) return null
  const resolvedRoot = resolveListRootInput(listRoot)
  if (!resolvedRoot) return null
  const listRootKey = resolvedRoot.key
  const listRootAbs = resolvedRoot.isRelativeKey
    ? resolveAbsoluteListRoot(listRootKey)
    : resolvedRoot.abs || resolveAbsoluteListRoot(listRootKey)
  if (!listRootAbs) return null
  const resolvedFile = resolveFilePathInput(listRootAbs, filePath)
  if (!resolvedFile) return null
  if (resolvedFile.isRelativeKey) {
    return resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
  }
  if (resolvedRoot.legacyAbs && resolvedRoot.legacyAbs !== listRootKey) {
    const legacyResolved = resolveFilePathInput(resolvedRoot.legacyAbs, filePath)
    if (legacyResolved && legacyResolved.isRelativeKey) {
      return resolveAbsoluteFilePath(listRootKey, legacyResolved.key)
    }
  }
  return resolvedFile.abs || resolveAbsoluteFilePath(listRootKey, resolvedFile.key)
}

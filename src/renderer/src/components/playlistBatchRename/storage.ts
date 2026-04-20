import { v4 as uuidV4 } from 'uuid'
import { i18n } from '@renderer/i18n'
import type {
  IBatchRenameTemplatePreset,
  IBatchRenameTemplateSegment,
  IBatchRenameTemplateToken
} from 'src/types/globals'

const STORAGE_KEY = 'frkb_playlist_batch_rename_v1'
const BUILTIN_PRESET_ID = 'playlist-batch-rename-builtin-default'

type BatchRenamePresetState = {
  presets: IBatchRenameTemplatePreset[]
  defaultPresetId: string
  lastUsedPresetId: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const getBuiltinPresetName = () =>
  i18n.global.locale.value === 'en-US' ? 'Default Template' : '默认模板'

export const createTextSegment = (value = ''): IBatchRenameTemplateSegment => ({
  id: uuidV4(),
  type: 'text',
  value
})

export const createTokenSegment = (
  token: IBatchRenameTemplateToken
): IBatchRenameTemplateSegment => ({
  id: uuidV4(),
  type: 'token',
  token
})

export const normalizeTemplateSegments = (
  segments: IBatchRenameTemplateSegment[] | undefined | null
): IBatchRenameTemplateSegment[] => {
  const source = Array.isArray(segments) ? segments : []
  const normalized: IBatchRenameTemplateSegment[] = []
  for (const segment of source) {
    if (!segment || typeof segment !== 'object') continue
    if (segment.type === 'token' && typeof segment.token === 'string') {
      normalized.push({
        id: typeof segment.id === 'string' && segment.id.trim() ? segment.id : uuidV4(),
        type: 'token',
        token: segment.token
      })
      continue
    }
    if (segment.type === 'text') {
      const value = typeof segment.value === 'string' ? segment.value : ''
      const last = normalized[normalized.length - 1]
      if (last?.type === 'text') {
        last.value += value
      } else {
        normalized.push({
          id: typeof segment.id === 'string' && segment.id.trim() ? segment.id : uuidV4(),
          type: 'text',
          value
        })
      }
    }
  }
  if (normalized.length === 0) {
    return [createTextSegment('')]
  }
  if (normalized[0]?.type !== 'text') {
    normalized.unshift(createTextSegment(''))
  }
  if (normalized[normalized.length - 1]?.type !== 'text') {
    normalized.push(createTextSegment(''))
  }
  return normalized
}

const createBuiltinPreset = (): IBatchRenameTemplatePreset => ({
  id: BUILTIN_PRESET_ID,
  name: getBuiltinPresetName(),
  segments: normalizeTemplateSegments([
    createTokenSegment('title'),
    createTextSegment(' - '),
    createTokenSegment('artist')
  ]),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isDefault: true,
  isBuiltin: true
})

const getStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const sanitizePreset = (value: unknown): IBatchRenameTemplatePreset | null => {
  if (!isPlainObject(value)) return null
  const id = typeof value.id === 'string' && value.id.trim() ? value.id : uuidV4()
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : ''
  if (!name) return null
  return {
    id,
    name,
    segments: normalizeTemplateSegments(value.segments as IBatchRenameTemplateSegment[]),
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    isDefault: !!value.isDefault,
    isBuiltin: id === BUILTIN_PRESET_ID || !!value.isBuiltin
  }
}

const normalizeState = (value: unknown): BatchRenamePresetState => {
  const rawPresets = isPlainObject(value) && Array.isArray(value.presets) ? value.presets : []
  const presets = rawPresets
    .map(sanitizePreset)
    .filter((item): item is IBatchRenameTemplatePreset => !!item)
  let builtin = presets.find((item) => item.id === BUILTIN_PRESET_ID)
  if (!builtin) {
    builtin = createBuiltinPreset()
    presets.unshift(builtin)
  }
  const defaultPresetId =
    isPlainObject(value) &&
    typeof value.defaultPresetId === 'string' &&
    presets.some((item) => item.id === value.defaultPresetId)
      ? value.defaultPresetId
      : BUILTIN_PRESET_ID
  const lastUsedPresetId =
    isPlainObject(value) &&
    typeof value.lastUsedPresetId === 'string' &&
    presets.some((item) => item.id === value.lastUsedPresetId)
      ? value.lastUsedPresetId
      : defaultPresetId
  return {
    presets: presets.map((item) => ({
      ...item,
      isDefault: item.id === defaultPresetId,
      isBuiltin: item.id === BUILTIN_PRESET_ID || !!item.isBuiltin
    })),
    defaultPresetId,
    lastUsedPresetId
  }
}

export const readBatchRenamePresetState = (): BatchRenamePresetState => {
  const storage = getStorage()
  if (!storage) {
    const builtin = createBuiltinPreset()
    return {
      presets: [builtin],
      defaultPresetId: builtin.id,
      lastUsedPresetId: builtin.id
    }
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    const builtin = createBuiltinPreset()
    return {
      presets: [builtin],
      defaultPresetId: builtin.id,
      lastUsedPresetId: builtin.id
    }
  }
  try {
    return normalizeState(JSON.parse(raw))
  } catch {
    const builtin = createBuiltinPreset()
    return {
      presets: [builtin],
      defaultPresetId: builtin.id,
      lastUsedPresetId: builtin.id
    }
  }
}

export const writeBatchRenamePresetState = (
  value: BatchRenamePresetState
): BatchRenamePresetState => {
  const normalized = normalizeState(value)
  const storage = getStorage()
  if (!storage) return normalized
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {}
  return normalized
}

export { BUILTIN_PRESET_ID }

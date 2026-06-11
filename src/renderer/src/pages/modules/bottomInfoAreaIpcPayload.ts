import { toRaw } from 'vue'

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const toIpcCloneablePayload = (value: unknown): unknown => {
  const rawValue = toRaw(value)
  if (Array.isArray(rawValue)) {
    return rawValue.map((item) => toIpcCloneablePayload(item))
  }
  if (isPlainRecord(rawValue)) {
    const plain: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(rawValue)) {
      plain[key] = toIpcCloneablePayload(item)
    }
    return plain
  }
  return rawValue
}

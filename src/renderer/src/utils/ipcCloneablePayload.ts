import { toRaw } from 'vue'

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const toIpcCloneablePayload = <T>(value: T): T => {
  const cloneUnknown = (input: unknown): unknown => {
    const rawValue = toRaw(input)
    if (Array.isArray(rawValue)) {
      return rawValue.map((item) => cloneUnknown(item))
    }
    if (isPlainRecord(rawValue)) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(rawValue)) {
        plain[key] = cloneUnknown(item)
      }
      return plain
    }
    return rawValue
  }
  return cloneUnknown(value) as T
}

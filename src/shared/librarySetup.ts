export type LibrarySetupMode = 'required' | 'reselect'

export type LibrarySetupErrorHint =
  | {
      kind: 'schema-too-new'
      databaseUrl: string
      databaseVersion: number
      maximumSupportedVersion: number
    }
  | {
      kind: 'cannot-read'
      databaseUrl: string
    }

export type LibrarySetupState = {
  active: boolean
  mode: LibrarySetupMode | null
  errorHint: LibrarySetupErrorHint | null
}

export const EMPTY_LIBRARY_SETUP_STATE: LibrarySetupState = {
  active: false,
  mode: null,
  errorHint: null
}

export const isLibrarySetupMode = (value: unknown): value is LibrarySetupMode =>
  value === 'required' || value === 'reselect'

export const isLibrarySetupErrorHint = (value: unknown): value is LibrarySetupErrorHint => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const hint = value as { kind?: unknown; databaseUrl?: unknown }
  if (typeof hint.databaseUrl !== 'string' || !hint.databaseUrl.trim()) return false
  if (hint.kind === 'cannot-read') return true
  if (hint.kind !== 'schema-too-new') return false
  const schemaHint = value as {
    databaseVersion?: unknown
    maximumSupportedVersion?: unknown
  }
  return (
    Number.isFinite(Number(schemaHint.databaseVersion)) &&
    Number.isFinite(Number(schemaHint.maximumSupportedVersion))
  )
}

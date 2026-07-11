export type FileSystemItem = {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number | null
  isSpecial?: boolean
}

export type SelectedItem = {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number | null
}

export type SelectionModifiers = {
  shift: boolean
  ctrlOrMeta: boolean
}

export type CustomFileSelectorProps = {
  visible: boolean
  multiSelect: boolean
  allowMixedSelection: boolean
  initialSelectedPaths: string[]
}

export type CustomFileSelectorEmits = {
  (event: 'update:visible', visible: boolean): void
  (event: 'confirm', paths: string[]): void
  (event: 'cancel'): void
}

export type FileSystemItem = {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileSystemItem[]
  isExpanded?: boolean
  isSelected?: boolean
  isVisible?: boolean
  parent?: FileSystemItem
}

export type SelectedItem = {
  id: string
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
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

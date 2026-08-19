import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import { t } from '@renderer/utils/translate'

type RelocateErrorPayload = {
  success?: boolean
  code?: string
  message?: string
  blocking?: string[]
  cancellable?: string[]
  canceled?: boolean
  parentPath?: string | null
  preview?: {
    sourcePath: string
    destPath: string
    totalBytes: number
    totalFiles: number
    sameVolume: boolean
  }
}

let flowRunning = false

const formatBytes = (value: number) => {
  const bytes = Math.max(0, Number(value) || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let result = bytes
  while (result >= 1024 && index < units.length - 1) {
    result /= 1024
    index += 1
  }
  const precision = index === 0 || result >= 100 ? 0 : 1
  return `${result.toFixed(precision)} ${units[index]}`
}

const isSuccess = (value: unknown): value is RelocateErrorPayload =>
  !!value && typeof value === 'object' && (value as RelocateErrorPayload).success === true

const getIssueText = (payload: RelocateErrorPayload) => {
  const code = String(payload.code || '')
  const key = `migration.moveDialog.issues.${code}`
  const translated = t(key)
  return translated === key ? payload.message || t('common.unknownError') : translated
}

const formatBusyLines = (payload: RelocateErrorPayload): string[] => {
  const reasons = [...(payload.blocking || []), ...(payload.cancellable || [])]
  const unique = Array.from(new Set(reasons.filter(Boolean)))
  if (unique.length === 0) return [`• ${t('migration.mergeDialog.busyReasons.unknown')}`]
  return unique.map((reason) => {
    const key = `migration.mergeDialog.busyReasons.${reason}`
    const label = t(key)
    return `• ${label === key ? t('migration.mergeDialog.busyReasons.unknown') : label}`
  })
}

const showError = async (payload: RelocateErrorPayload) => {
  if (payload.code === 'LIBRARY_BUSY') {
    await confirm({
      title: t('migration.moveDialog.busyBlockingTitle'),
      content: [t('migration.moveDialog.busyBlockingLead'), ...formatBusyLines(payload)],
      confirmShow: false,
      textAlign: 'left',
      cancelText: t('common.close')
    })
    return
  }
  await confirm({
    title: t('migration.moveDialog.title'),
    content: [getIssueText(payload)],
    confirmShow: false
  })
}

export const startLibraryRelocateFromMenu = async () => {
  if (flowRunning) return
  const runtime = useRuntimeStore()
  if (runtime.isProgressing) {
    await confirm({
      title: t('dialog.hint'),
      content: [t('import.waitForTask')],
      confirmShow: false
    })
    return
  }
  flowRunning = true
  try {
    const ready = (await window.electron.ipcRenderer.invoke(
      'library-relocate:check-ready'
    )) as RelocateErrorPayload
    if (!isSuccess(ready)) {
      await showError(ready)
      return
    }
    const selected = (await window.electron.ipcRenderer.invoke(
      'library-relocate:select-parent'
    )) as RelocateErrorPayload
    if (!isSuccess(selected)) {
      await showError(selected)
      return
    }
    if (selected.canceled || !selected.parentPath) return

    const previewResult = (await window.electron.ipcRenderer.invoke('library-relocate:preview', {
      parentPath: selected.parentPath
    })) as RelocateErrorPayload
    if (!isSuccess(previewResult) || !previewResult.preview) {
      await showError(previewResult)
      return
    }
    const preview = previewResult.preview
    const confirmed = await confirm({
      title: t('migration.moveDialog.title'),
      content: [
        t('migration.moveDialog.confirmLead'),
        t('migration.moveDialog.currentPath', { path: preview.sourcePath }),
        t('migration.moveDialog.newPath', { path: preview.destPath }),
        t('migration.moveDialog.sizeSummary', {
          size: formatBytes(preview.totalBytes),
          count: preview.totalFiles
        }),
        preview.sameVolume
          ? t('migration.moveDialog.sameVolume')
          : t('migration.moveDialog.crossVolume')
      ],
      confirmShow: true,
      textAlign: 'left',
      canCopyText: true,
      confirmText: t('migration.moveDialog.confirmAction'),
      innerWidth: 520
    })
    if (confirmed !== 'confirm') return

    const started = (await window.electron.ipcRenderer.invoke('library-relocate:start', {
      parentPath: selected.parentPath
    })) as RelocateErrorPayload
    if (!isSuccess(started)) {
      await showError(started)
    }
  } finally {
    flowRunning = false
  }
}

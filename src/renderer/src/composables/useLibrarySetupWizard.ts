import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue'
import hotkeys from 'hotkeys-js'
import { t } from '@renderer/utils/translate'
import { useRuntimeStore } from '@renderer/stores/runtime'
import confirm from '@renderer/components/confirmDialog'
import choice from '@renderer/components/choiceDialog'
import { applyLibrarySetupState } from '@renderer/utils/librarySetupRuntime'
import type { LibrarySetupErrorHint } from '@shared/librarySetup'

export type LibrarySetupStep = 'choice' | 'create-path' | 'create-fingerprint' | 'existing'
type FingerprintMode = 'pcm' | 'file'

const DEFAULT_DB_NAME = 'FRKB'
const LIBRARY_SETUP_HOTKEY_SCOPE = 'windowGlobal'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readTrimmedString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

const persistCurrentSetting = async () => {
  const runtime = useRuntimeStore()
  await window.electron.ipcRenderer.invoke(
    'setSetting',
    JSON.parse(JSON.stringify(runtime.setting))
  )
}

const initLibrary = async (
  dirPath: string,
  options?: { createSamples?: boolean; reset?: boolean; fingerprintMode?: FingerprintMode }
) => {
  return await window.electron.ipcRenderer.invoke('library-setup:init', dirPath, options)
}

export const useLibrarySetupWizard = (flashArea: Ref<string>) => {
  const runtime = useRuntimeStore()
  const step = ref<LibrarySetupStep>('choice')
  const folderPathVal = ref('')
  const dbName = ref(DEFAULT_DB_NAME)
  const fingerprintMode = ref<FingerprintMode | ''>('')
  const windowsHideExt = ref(false)
  const submitting = ref(false)
  const sep = computed(() => (runtime.setting.platform === 'win32' ? '\\' : '/'))
  const targetDir = computed(() =>
    folderPathVal.value && dbName.value.trim()
      ? folderPathVal.value.replace(/[\\/]+$/, '') + sep.value + dbName.value.trim()
      : ''
  )
  const manifestDisplayName = computed(() =>
    windowsHideExt.value ? 'FRKB.database' : 'FRKB.database.frkbdb'
  )
  const fingerprintModeModel = computed<string>({
    get: () => fingerprintMode.value,
    set: (value) => {
      fingerprintMode.value = value === 'file' ? 'file' : value === 'pcm' ? 'pcm' : ''
    }
  })
  const normalizeFingerprintMode = (
    value: unknown,
    fallback: FingerprintMode = 'pcm'
  ): FingerprintMode => (value === 'file' ? 'file' : value === 'pcm' ? 'pcm' : fallback)

  const flashBorder = (flashAreaName: string) => {
    flashArea.value = flashAreaName
    let count = 0
    const interval = setInterval(() => {
      count++
      if (count >= 3) {
        clearInterval(interval)
        flashArea.value = ''
      }
    }, 500)
  }

  const handleInsideExistingLibrary = async (root: string) => {
    const key = await choice({
      title: t('common.warning'),
      content: [t('database.parentIsInsideDb')],
      options: [
        { key: 'enter', label: t('database.enterExisting') },
        { key: 'reset', label: t('database.resetRebuild') },
        { key: 'cancel', label: t('common.cancel') }
      ],
      innerHeight: 220,
      innerWidth: 520
    })
    if (key === 'enter') {
      runtime.setting.databaseUrl = root
      await persistCurrentSetting()
      await initLibrary(root, { createSamples: false })
      return true
    }
    if (key === 'reset') {
      runtime.setting.databaseUrl = root
      await persistCurrentSetting()
      await initLibrary(root, { createSamples: true, reset: true })
      return true
    }
    return false
  }

  let clickChooseDirFlag = false
  const clickChooseDir = async () => {
    if (clickChooseDirFlag || submitting.value) return
    clickChooseDirFlag = true
    const folderPath = await window.electron.ipcRenderer.invoke(
      'select-folder',
      false,
      folderPathVal.value.trim() || undefined
    )
    clickChooseDirFlag = false
    if (!folderPath) return
    const selected = folderPath[0]
    let root: string | null = null
    try {
      root = await window.electron.ipcRenderer.invoke('find-db-root-upwards', selected)
    } catch {}
    if (root) {
      await handleInsideExistingLibrary(root)
      return
    }
    folderPathVal.value = selected
  }

  const clickChooseExistingDb = async () => {
    if (submitting.value) return
    const result: unknown = await window.electron.ipcRenderer.invoke(
      'select-existing-database-file'
    )
    if (!result) return
    if (isRecord(result) && result.error === 'incompatible') {
      await confirm({
        title: t('common.error'),
        content: [
          t('database.incompatibleManifest', {
            minVersion: readTrimmedString(result, 'minAppVersion') || '-',
            currentVersion: readTrimmedString(result, 'appVersion') || '-'
          })
        ],
        confirmShow: false
      })
      return
    }
    if (result === 'error') {
      await confirm({
        title: t('common.error'),
        content: [t('database.invalidManifestFile')],
        confirmShow: false
      })
      return
    }
    const rootDir = isRecord(result) ? readTrimmedString(result, 'rootDir') : ''
    if (!rootDir) return
    submitting.value = true
    try {
      runtime.setting.databaseUrl = rootDir
      await persistCurrentSetting()
      await initLibrary(rootDir, { createSamples: false })
    } finally {
      submitting.value = false
    }
  }

  const submitCreate = async () => {
    if (submitting.value) return
    if (folderPathVal.value.length === 0) {
      if (!flashArea.value) flashBorder('folderPathVal')
      step.value = 'create-path'
      return
    }
    if (dbName.value.trim().length === 0) {
      if (!flashArea.value) flashBorder('dbName')
      step.value = 'create-path'
      return
    }
    if (!fingerprintMode.value) {
      if (!flashArea.value) flashBorder('fingerprintMode')
      step.value = 'create-fingerprint'
      return
    }

    try {
      const root = await window.electron.ipcRenderer.invoke(
        'find-db-root-upwards',
        folderPathVal.value
      )
      if (root) {
        await handleInsideExistingLibrary(root)
        return
      }
    } catch {}

    const dirForCreate = targetDir.value
    if (!dirForCreate) return

    let probe: { hasManifest: boolean; isLegacy: boolean; isEmpty: boolean } = {
      hasManifest: false,
      isLegacy: false,
      isEmpty: false
    }
    try {
      probe = await window.electron.ipcRenderer.invoke('probe-database-dir', dirForCreate)
    } catch {}

    if (probe.hasManifest) {
      const key = await choice({
        title: t('common.warning'),
        content: [t('database.dirHasDatabase'), t('database.dirHasDatabaseOptions')],
        options: [
          { key: 'enter', label: t('database.enterExisting') },
          { key: 'reset', label: t('database.resetRebuild') },
          { key: 'cancel', label: t('common.cancel') }
        ],
        innerHeight: 220,
        innerWidth: 520
      })
      if (key === 'enter') {
        runtime.setting.databaseUrl = dirForCreate
        await persistCurrentSetting()
        await initLibrary(dirForCreate, { createSamples: false })
        return
      }
      if (key === 'reset') {
        runtime.setting.databaseUrl = dirForCreate
        await persistCurrentSetting()
        await initLibrary(dirForCreate, { createSamples: true, reset: true })
        return
      }
      return
    }

    submitting.value = true
    try {
      runtime.setting.databaseUrl = dirForCreate
      await persistCurrentSetting()
      if (probe.isLegacy) {
        await initLibrary(dirForCreate, {
          createSamples: false,
          fingerprintMode: normalizeFingerprintMode(fingerprintMode.value, 'file')
        })
        return
      }
      await initLibrary(dirForCreate, {
        createSamples: true,
        fingerprintMode: normalizeFingerprintMode(fingerprintMode.value)
      })
    } finally {
      submitting.value = false
    }
  }

  const goCreate = () => {
    step.value = 'create-path'
  }
  const goExisting = () => {
    step.value = 'existing'
  }
  const goBack = () => {
    if (step.value === 'create-fingerprint') {
      step.value = 'create-path'
      return
    }
    step.value = 'choice'
  }
  const goNextFromPath = () => {
    if (folderPathVal.value.length === 0) {
      if (!flashArea.value) flashBorder('folderPathVal')
      return
    }
    if (dbName.value.trim().length === 0) {
      if (!flashArea.value) flashBorder('dbName')
      return
    }
    step.value = 'create-fingerprint'
  }

  const cancelOrExit = async () => {
    if (submitting.value) return
    if (step.value !== 'choice') {
      goBack()
      return
    }
    if (runtime.librarySetupMode === 'reselect') {
      const result: unknown = await window.electron.ipcRenderer.invoke('library-setup:cancel')
      const state =
        result && typeof result === 'object' && 'state' in result
          ? (result as { state?: unknown }).state
          : result
      applyLibrarySetupState(state)
      return
    }
    window.electron.ipcRenderer.send('toggle-close')
  }

  const showErrorHint = async (hint: LibrarySetupErrorHint) => {
    if (hint.kind === 'schema-too-new') {
      await confirm({
        title: t('common.error'),
        content: [
          hint.databaseUrl,
          t('database.schemaTooNew'),
          t('database.schemaVersion', {
            databaseVersion: hint.databaseVersion,
            maximumSupportedVersion: hint.maximumSupportedVersion
          }),
          t('database.updateRequired')
        ],
        confirmShow: false
      })
      return
    }
    await confirm({
      title: t('common.error'),
      content: [hint.databaseUrl, t('database.cannotRead'), t('database.possibleDamage')],
      confirmShow: false
    })
  }

  const handleShowErrorHint = async (_event: unknown, payload: unknown) => {
    const hint: LibrarySetupErrorHint =
      typeof payload === 'string'
        ? { kind: 'cannot-read', databaseUrl: payload }
        : (payload as LibrarySetupErrorHint)
    await showErrorHint(hint)
    await window.electron.ipcRenderer.invoke('library-setup:clearErrorHint')
    runtime.librarySetupErrorHint = null
  }

  const isLibrarySetupHotkeyForeground = () => {
    if (!runtime.librarySetupActive) return false
    const heap = runtime.hotkeysScopesHeap
    const top = heap.length > 0 ? heap[heap.length - 1] : LIBRARY_SETUP_HOTKEY_SCOPE
    return top === LIBRARY_SETUP_HOTKEY_SCOPE
  }
  const handleConfirmHotkey = () => {
    if (!isLibrarySetupHotkeyForeground()) return
    if (step.value === 'create-fingerprint') void submitCreate()
  }
  const handleEscapeHotkey = () => {
    if (!isLibrarySetupHotkeyForeground()) return
    void cancelOrExit()
  }

  onMounted(async () => {
    hotkeys('E,Enter', LIBRARY_SETUP_HOTKEY_SCOPE, handleConfirmHotkey)
    hotkeys('Esc', LIBRARY_SETUP_HOTKEY_SCOPE, handleEscapeHotkey)
    try {
      const hidden = await window.electron.ipcRenderer.invoke('get-windows-hide-ext')
      windowsHideExt.value = !!hidden
    } catch {}
    try {
      const parentDir = await window.electron.ipcRenderer.invoke('get-default-database-parent-dir')
      if (typeof parentDir === 'string' && parentDir.trim() && !folderPathVal.value) {
        folderPathVal.value = parentDir.trim()
      }
    } catch {}
    const pendingHint = runtime.librarySetupErrorHint
    if (pendingHint) {
      await showErrorHint(pendingHint)
      await window.electron.ipcRenderer.invoke('library-setup:clearErrorHint')
      runtime.librarySetupErrorHint = null
    }
    window.electron.ipcRenderer.on('databaseInitWindow-showErrorHint', handleShowErrorHint)
  })

  onUnmounted(() => {
    window.electron.ipcRenderer.removeListener(
      'databaseInitWindow-showErrorHint',
      handleShowErrorHint
    )
    hotkeys.unbind('E,Enter', handleConfirmHotkey)
    hotkeys.unbind('Esc', handleEscapeHotkey)
  })

  return {
    step,
    folderPathVal,
    dbName,
    targetDir,
    fingerprintModeModel,
    manifestDisplayName,
    submitting,
    clickChooseDir,
    clickChooseExistingDb,
    submitCreate,
    goCreate,
    goExisting,
    goBack,
    goNextFromPath,
    cancelOrExit
  }
}

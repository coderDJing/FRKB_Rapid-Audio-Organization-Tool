import { app, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { log } from '../log'
import url from '../url'
import store from '../store'
import whatsNewWindow, { type WhatsNewReleasePayload } from '../window/whatsNewWindow'
import fs = require('fs-extra')
import type { ISettingConfig } from '../../types/globals'

const WHATS_NEW_RELEASE_URL =
  'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'

type WhatsNewStatePatch = Partial<
  Pick<ISettingConfig, 'lastSeenWhatsNewVersion' | 'pendingWhatsNewForVersion'>
>

const toSafeString = (val: unknown): string => {
  if (typeof val === 'string') return val
  return ''
}

async function persistWhatsNewState(patch: WhatsNewStatePatch) {
  const nextSetting = {
    ...store.settingConfig,
    ...patch
  }
  store.settingConfig = nextSetting
  try {
    await fs.outputJson(url.settingConfigFileUrl, nextSetting)
  } catch (error) {
    log.error('[whatsNew] 持久化设置失败', error)
  }
}

async function fetchLatestStableRelease(
  currentVersion: string
): Promise<WhatsNewReleasePayload | null> {
  try {
    const res = await fetch(WHATS_NEW_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `FRKB/${currentVersion}`
      }
    })
    if (!res.ok) {
      log.error('[whatsNew] 拉取 GitHub release 失败', { status: res.status })
      return null
    }
    const data = await res.json()
    const payload: WhatsNewReleasePayload = {
      title: toSafeString(data?.name || data?.tag_name),
      tagName: toSafeString(data?.tag_name),
      body: toSafeString(data?.body),
      publishedAt: toSafeString(data?.published_at),
      htmlUrl: toSafeString(data?.html_url),
      currentVersion
    }
    return payload
  } catch (error) {
    log.error('[whatsNew] 拉取 GitHub release 异常', error)
    return null
  }
}

export async function maybeShowWhatsNew() {
  const currentVersion = app.getVersion()
  if (is.dev || currentVersion.includes('-')) {
    return
  }
  const lastSeen = toSafeString(store.settingConfig.lastSeenWhatsNewVersion)
  const pending = toSafeString(store.settingConfig.pendingWhatsNewForVersion)

  const shouldRetry = pending === currentVersion
  const isFirstLaunchForVersion = lastSeen !== currentVersion
  if (!shouldRetry && !isFirstLaunchForVersion) return

  const release = await fetchLatestStableRelease(currentVersion)
  if (!release) {
    await persistWhatsNewState({ pendingWhatsNewForVersion: currentVersion })
    return
  }

  await persistWhatsNewState({ pendingWhatsNewForVersion: '' })
  whatsNewWindow.open(release)
}

export function registerWhatsNewHandlers() {
  ipcMain.on('whatsNew-acknowledge', async (_event, options?: { skipClose?: boolean }) => {
    try {
      const currentVersion = app.getVersion()
      await persistWhatsNewState({
        lastSeenWhatsNewVersion: currentVersion,
        pendingWhatsNewForVersion: ''
      })
    } catch (error) {
      log.error('[whatsNew] 记录已查看版本失败', error)
    } finally {
      if (!options?.skipClose) {
        try {
          whatsNewWindow.instance?.close()
        } catch {}
      }
    }
  })

  ipcMain.on('showWhatsNew', async () => {
    try {
      const release = await fetchLatestStableRelease(app.getVersion())
      if (release) {
        whatsNewWindow.open(release)
      }
    } catch (error) {
      log.error('[whatsNew] showWhatsNew 手动打开失败', error)
    }
  })
}

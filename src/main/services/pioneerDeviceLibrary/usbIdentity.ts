import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path = require('path')
import fs = require('fs-extra')
import { log } from '../../log'

const USB_ID_FILE_NAME = '.frkb-usb-id.json'
const USB_ID_VERSION = 1

export type PioneerUsbIdentity = {
  uuid: string
  filePath: string
  created: boolean
  persisted: boolean
}

type UsbIdentityFile = {
  uuid?: unknown
  version?: unknown
}

const isUuidText = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())

const readUsbIdentityFile = async (filePath: string): Promise<string> => {
  try {
    const parsed = (await fs.readJson(filePath)) as UsbIdentityFile
    return isUuidText(parsed?.uuid) ? parsed.uuid.trim().toLowerCase() : ''
  } catch {
    return ''
  }
}

const hideUsbIdentityFile = async (filePath: string) => {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => {
    execFile('attrib', ['+h', filePath], { windowsHide: true }, () => resolve())
  })
}

export async function ensurePioneerUsbIdentity(rootPath: string): Promise<PioneerUsbIdentity> {
  const normalizedRoot = String(rootPath || '').trim()
  const filePath = path.join(normalizedRoot, USB_ID_FILE_NAME)
  if (!normalizedRoot) {
    return {
      uuid: '',
      filePath,
      created: false,
      persisted: false
    }
  }

  const existingUuid = await readUsbIdentityFile(filePath)
  if (existingUuid) {
    await hideUsbIdentityFile(filePath).catch(() => {})
    return {
      uuid: existingUuid,
      filePath,
      created: false,
      persisted: true
    }
  }

  const uuid = randomUUID()
  try {
    await fs.outputJson(
      filePath,
      {
        uuid,
        version: USB_ID_VERSION
      },
      { spaces: 2 }
    )
    await hideUsbIdentityFile(filePath).catch(() => {})
    return {
      uuid,
      filePath,
      created: true,
      persisted: true
    }
  } catch (error) {
    log.error('[pioneer-device-library] usb identity create failed', {
      rootPath: normalizedRoot,
      filePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      uuid,
      filePath,
      created: true,
      persisted: false
    }
  }
}

export { USB_ID_FILE_NAME }

import { describe, expect, it } from 'vitest'
import { buildWindowsRemovableDriveRows, readUsbLetterProbe } from './deviceDetection'

describe('buildWindowsRemovableDriveRows', () => {
  it('保留可移动盘，并把 USB 固定盘算进去', () => {
    const rows = buildWindowsRemovableDriveRows(
      [
        {
          deviceId: 'E:',
          driveType: 2,
          volumeName: 'Stick',
          fileSystem: 'FAT32',
          size: 10,
          freeSpace: 4
        },
        {
          deviceId: 'F:',
          driveType: 3,
          volumeName: 'Internal',
          fileSystem: 'NTFS',
          size: 20,
          freeSpace: 5
        },
        {
          deviceId: 'G:',
          driveType: 3,
          volumeName: 'USB HDD',
          fileSystem: 'NTFS',
          size: 30,
          freeSpace: 6
        }
      ],
      new Set(['G:'])
    )
    expect(rows.map((row) => row.id)).toEqual(['E:', 'G:'])
    expect(rows.find((row) => row.id === 'E:')).toMatchObject({ isUsb: false, driveType: 2 })
    expect(rows.find((row) => row.id === 'G:')).toMatchObject({
      isUsb: true,
      driveType: 3,
      volumeName: 'USB HDD'
    })
  })
})

describe('readUsbLetterProbe', () => {
  it('脚本内部写了 stderr 时不能当成没有 USB 盘', () => {
    const probe = readUsbLetterProbe(
      '[]',
      'cim-usb-association: timeout\r\nstorage-usb-association: timeout'
    )
    expect(probe.complete).toBe(false)
    expect([...probe.letters]).toEqual([])
  })

  it('没有 stderr 时，空列表表示确实没有 USB 盘符', () => {
    const probe = readUsbLetterProbe('[]', '  ')
    expect(probe.complete).toBe(true)
    expect([...probe.letters]).toEqual([])
  })

  it('单个盘符不会被当成对象丢掉', () => {
    const probe = readUsbLetterProbe('"g:"', '')
    expect(probe.complete).toBe(true)
    expect([...probe.letters]).toEqual(['G:'])
  })
})

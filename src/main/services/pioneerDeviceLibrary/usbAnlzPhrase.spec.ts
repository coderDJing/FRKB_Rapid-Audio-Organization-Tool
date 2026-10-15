import { describe, expect, it } from 'vitest'
import { validateUsbAnlzPhraseForGridShift } from './usbAnlzPhrase'
import { parseUsbAnlz, shiftUsbAnlzGrid } from './usbAnlzWrite'

const phrase = (version: number, masked: boolean) => {
  const bytes = Buffer.alloc(80)
  bytes.write('PSSI')
  bytes.writeUInt32BE(32, 4)
  bytes.writeUInt32BE(bytes.length, 8)
  bytes.writeUInt16BE(version, 12)
  bytes.writeUInt16BE(24, 14)
  bytes.writeUInt16BE(2, 16)
  bytes.writeUInt16BE(2, 18)
  bytes.writeUInt16BE(65, 26)
  bytes[30] = 3
  for (const [index, beat] of [1, 33].entries()) {
    bytes.writeUInt16BE(index + 1, 32 + index * 24)
    bytes.writeUInt16BE(beat, 34 + index * 24)
    bytes.writeUInt16BE(1, 36 + index * 24)
  }
  if (masked) {
    const seed = Buffer.from('Kanzen-niRikaishita', 'ascii')
    for (let i = 18; i < bytes.length; i++) {
      bytes[i] ^= (seed[(i - 18 + version) % seed.length] + 0x80 + 2) & 0xff
    }
  }
  return bytes
}

describe('USB PSSI grid shift compatibility', () => {
  for (const version of [0, 1]) {
    for (const masked of [false, true]) {
      it(`preserves version ${version}, masked=${masked} when shifting across beat zero`, () => {
        const pssi = phrase(version, masked)
        const before = Buffer.from(pssi)
        const grid = Buffer.alloc(40)
        grid.write('PQTZ')
        grid.writeUInt32BE(24, 4)
        grid.writeUInt32BE(40, 8)
        grid.writeUInt32BE(0x80000, 16)
        grid.writeUInt32BE(2, 20)
        for (let i = 0; i < 2; i++) {
          grid.writeUInt16BE(i + 1, 24 + i * 8)
          grid.writeUInt16BE(12000, 26 + i * 8)
          grid.writeUInt32BE(100 + i * 500, 28 + i * 8)
        }
        const header = Buffer.alloc(28)
        header.write('PMAI')
        header.writeUInt32BE(28, 4)
        header.writeUInt32BE(28 + grid.length + pssi.length, 8)
        const result = shiftUsbAnlzGrid(Buffer.concat([header, grid, pssi]), -200, 1000)
        expect(result.changesBeatIndices).toBe(true)
        const preserved = parseUsbAnlz(result.bytes).sections.find((tag) => tag.kind === 'PSSI')
        expect(preserved?.bytes).toEqual(before)
        expect(pssi).toEqual(before)
      })
    }
  }

  it('rejects unknown versions, malformed sizes, truncation and invalid encoding', () => {
    const unknown = phrase(2, false)
    const badSize = phrase(1, false)
    badSize.writeUInt16BE(25, 14)
    const badMood = phrase(1, false)
    badMood.writeUInt16BE(0, 18)
    for (const bytes of [unknown, badSize, phrase(1, true).subarray(0, 79), badMood]) {
      expect(() => validateUsbAnlzPhraseForGridShift(bytes)).toThrow('PSSI')
    }
  })
})

import fs = require('fs-extra')
import path = require('path')
import iconv = require('iconv-lite')

type SimpleTags = {
  title?: string
  artist?: string
  album?: string
  genre?: string
  date?: string
  comment?: string
}

function isChineseLocale(): boolean {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || ''
    return /^zh(-|$)/i.test(loc)
  } catch {
    return false
  }
}

function encodeText(value: string, encoding: string): Buffer {
  // INFO 常见实现允许不以 0 结尾，但加入结尾 0 兼容更广
  // 对 UTF-16LE 使用 0x00 0x00 结尾
  let buf: Buffer
  if (encoding.toLowerCase().startsWith('utf16')) {
    const core = iconv.encode(value, encoding)
    const term = Buffer.from([0x00, 0x00])
    buf = Buffer.concat([core, term])
  } else {
    buf = iconv.encode(value + '\u0000', encoding)
  }
  // 偶数字节对齐
  if (buf.length % 2 !== 0) {
    return Buffer.concat([buf, Buffer.from([0x00])])
  }
  return buf
}

function buildInfoSubchunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.write(fourcc, 0, 'ascii')
  header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data])
}

function buildListInfoChunk(tags: SimpleTags, encoding: string): Buffer | null {
  const subchunks: Buffer[] = []
  const add = (fourcc: string, value?: string) => {
    if (typeof value !== 'string') return
    const v = value.replace(/\u0000/g, '').trim()
    if (!v) return
    const data = encodeText(v, encoding)
    subchunks.push(buildInfoSubchunk(fourcc, data))
  }
  add('INAM', tags.title)
  add('IART', tags.artist)
  add('IPRD', tags.album)
  add('IGNR', tags.genre)
  add('ICRD', tags.date)
  add('ICMT', tags.comment)

  if (subchunks.length === 0) return null

  const data = Buffer.concat([Buffer.from('INFO', 'ascii'), ...subchunks])
  const header = Buffer.alloc(8)
  header.write('LIST', 0, 'ascii')
  header.writeUInt32LE(data.length, 4)
  const chunk = Buffer.concat([header, data])
  // LIST 本身也需要偶数字节对齐
  if (chunk.length % 2 !== 0) {
    return Buffer.concat([chunk, Buffer.from([0x00])])
  }
  return chunk
}

function removeExistingListInfoChunks(wav: Buffer): { header: Buffer; chunks: Buffer[] } {
  if (wav.length < 12) throw new Error('Invalid WAV: too short')
  const riff = wav.slice(0, 4).toString('ascii')
  const wave = wav.slice(8, 12).toString('ascii')
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('Invalid WAV: missing RIFF/WAVE')

  const header = wav.slice(0, 12) // 'RIFF' + size + 'WAVE'
  const chunks: Buffer[] = []
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.slice(offset, offset + 4).toString('ascii')
    const size = wav.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = Math.min(dataStart + size, wav.length)
    const next = dataEnd + (size % 2 === 1 ? 1 : 0)

    if (id === 'LIST' && dataEnd - dataStart >= 4) {
      const listType = wav.slice(dataStart, dataStart + 4).toString('ascii')
      if (listType === 'INFO') {
        // 跳过该 LIST/INFO，不保留
        offset = next
        continue
      }
    }
    chunks.push(wav.slice(offset, next))
    offset = next
  }
  return { header, chunks }
}

export async function writeWavRiffInfoWindows(filePath: string, tags: SimpleTags): Promise<void> {
  if (process.platform !== 'win32') return
  // 与 foobar2000 保持一致：使用系统本地代码页写 INFO
  // 中文环境用 GBK，其它环境用 Windows-1252
  const encoding = isChineseLocale() ? 'gbk' : 'win1252'

  const wav = await fs.readFile(filePath)
  const listInfo = buildListInfoChunk(tags, encoding)
  if (!listInfo) return
  const { header, chunks } = removeExistingListInfoChunks(wav)

  const body = Buffer.concat([...chunks, listInfo])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length + 4) // 'WAVE' + body
  const rebuilt = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    riffSize,
    Buffer.from('WAVE', 'ascii'),
    body
  ])
  await fs.writeFile(filePath, rebuilt)
}

function looksUtf16(raw: Buffer): 'utf16-le' | 'utf16-be' | null {
  if (raw.length >= 2) {
    const b0 = raw[0]
    const b1 = raw[1]
    if (b0 === 0xff && b1 === 0xfe) return 'utf16-le'
    if (b0 === 0xfe && b1 === 0xff) return 'utf16-be'
  }
  // 统计零字节分布以粗略判断 UTF-16LE（中文多在高字节）
  let evenZeros = 0
  let oddZeros = 0
  const n = Math.min(raw.length, 128)
  for (let i = 0; i < n; i++) {
    if (raw[i] === 0) {
      if (i % 2 === 0) evenZeros++
      else oddZeros++
    }
  }
  // 对中文常见 UTF-16LE：偶数位多为非零，奇数位零较多；但标题短时样本偏差较大，阈值放宽
  if (oddZeros >= evenZeros * 2 && oddZeros >= 4) return 'utf16-le'
  if (evenZeros >= oddZeros * 2 && evenZeros >= 4) return 'utf16-be'
  return null
}

function decodeInfoText(raw: Buffer): string {
  try {
    const encByBom = looksUtf16(raw)
    if (encByBom) {
      const text = iconv
        .decode(raw, encByBom)
        .replace(/\u0000+$/g, '')
        .trim()
      if (text) return text
    }
  } catch {}
  try {
    const preferred = isChineseLocale() ? 'gbk' : 'win1252'
    const text = iconv
      .decode(raw, preferred)
      .replace(/\u0000+$/g, '')
      .trim()
    if (text) return text
  } catch {}
  try {
    const text = iconv
      .decode(raw, 'latin1')
      .replace(/\u0000+$/g, '')
      .trim()
    if (text) return text
  } catch {}
  return ''
}

export async function readWavRiffInfoWindows(filePath: string): Promise<SimpleTags | null> {
  if (process.platform !== 'win32') return null
  if (!isChineseLocale()) return null
  let wav: Buffer
  try {
    wav = await fs.readFile(filePath)
  } catch {
    return null
  }
  if (wav.length < 12) return null
  const riff = wav.slice(0, 4).toString('ascii')
  const wave = wav.slice(8, 12).toString('ascii')
  if (riff !== 'RIFF' || wave !== 'WAVE') return null

  const result: SimpleTags = {}
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.slice(offset, offset + 4).toString('ascii')
    const size = wav.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = Math.min(dataStart + size, wav.length)
    const next = dataEnd + (size % 2 === 1 ? 1 : 0)

    if (id === 'LIST' && dataEnd - dataStart >= 4) {
      const listType = wav.slice(dataStart, dataStart + 4).toString('ascii')
      if (listType === 'INFO') {
        let p = dataStart + 4
        while (p + 8 <= dataEnd) {
          const fourcc = wav.slice(p, p + 4).toString('ascii')
          const subSize = wav.readUInt32LE(p + 4)
          const subDataStart = p + 8
          const subDataEnd = Math.min(subDataStart + subSize, dataEnd)
          const raw = wav.slice(subDataStart, subDataEnd)
          const text = decodeInfoText(raw)
          const assign = (key: keyof SimpleTags, v: string) => {
            if (v && !(key in result)) (result as any)[key] = v
          }
          if (text) {
            if (fourcc === 'INAM') assign('title', text)
            else if (fourcc === 'IART') assign('artist', text)
            else if (fourcc === 'IPRD') assign('album', text)
            else if (fourcc === 'IGNR') assign('genre', text)
            else if (fourcc === 'ICRD') assign('date', text)
            else if (fourcc === 'ICMT') assign('comment', text)
          }
          p = subDataEnd + (subSize % 2 === 1 ? 1 : 0)
        }
      }
    }
    offset = next
  }
  return Object.keys(result).length ? result : null
}

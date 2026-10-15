/** Native manual grid shifts preserve the complete phrase tag, including beat indices. */
export const validateUsbAnlzPhraseForGridShift = (bytes: Buffer): void => {
  if (
    bytes.length < 32 ||
    bytes.toString('ascii', 0, 4) !== 'PSSI' ||
    bytes.readUInt32BE(4) !== 32 ||
    bytes.readUInt32BE(8) !== bytes.length ||
    bytes.readUInt16BE(12) > 1 ||
    bytes.readUInt16BE(14) !== 24 ||
    bytes.length !== 32 + bytes.readUInt16BE(16) * 24
  )
    throw new Error('不支持的 PSSI 乐句结构，无法确认网格平移兼容性')

  const mood = bytes.readUInt16BE(18)
  if (mood >= 1 && mood <= 3) return
  // Exported PSSI masks the body from byte 18, with phrase count added to the key.
  // Only identify the known encoding; never decode/re-encode or rewrite its indices.
  const count = bytes.readUInt16BE(16)
  const mask = Buffer.from('cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1', 'hex')
  const maskStart = bytes.readUInt16BE(12) % mask.length
  const unmaskedMood =
    ((bytes[18] ^ ((mask[maskStart] + count) & 0xff)) << 8) |
    (bytes[19] ^ ((mask[(maskStart + 1) % mask.length] + count) & 0xff))
  if (unmaskedMood < 1 || unmaskedMood > 3)
    throw new Error('不支持的 PSSI 乐句编码，无法确认网格平移兼容性')
}

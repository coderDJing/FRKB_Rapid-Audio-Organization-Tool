import { log } from '../log'

// 自动更新失败分类：网络栈/GitHub 短暂不可用不当作程序错误落盘。

export type UpdateErrorKind = 'network' | 'signature' | 'install' | 'unknown'

export type UpdateNetworkReason =
  | 'connection-reset'
  | 'connection-refused'
  | 'timeout'
  | 'dns'
  | 'offline'
  | 'proxy'
  | 'tls'
  | 'http-unavailable'
  | 'generic'

export type UpdateErrorClassification = {
  kind: UpdateErrorKind
  code: string | null
  networkReason?: UpdateNetworkReason
  message: string
}

type CollectedErrorParts = {
  texts: string[]
  codes: string[]
  statusCodes: number[]
}

const NODE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_DESTROYED',
  'ERR_SOCKET_CLOSED',
  'ERR_NETWORK',
  'ERR_INTERNET_DISCONNECTED'
])

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PROTOCOL_ERROR'
])

const HTTP_UNAVAILABLE_STATUS = new Set([
  408, 425, 429, 500, 502, 503, 504, 509, 521, 522, 523, 524, 525, 526
])

const isChromiumNetCode = (code: string): boolean => {
  if (
    !code.startsWith('ERR_') ||
    code.startsWith('ERR_UPDATER_') ||
    code === 'ERR_REQUEST_FAILED'
  ) {
    return false
  }
  return (
    code.startsWith('ERR_CONNECTION_') ||
    code.startsWith('ERR_NAME_') ||
    code.startsWith('ERR_INTERNET_') ||
    code.startsWith('ERR_ADDRESS_') ||
    code.startsWith('ERR_NETWORK_') ||
    code.startsWith('ERR_PROXY_') ||
    code.startsWith('ERR_TUNNEL_') ||
    code.startsWith('ERR_SOCKS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('ERR_CERT_') ||
    code.startsWith('ERR_DNS_') ||
    code.startsWith('ERR_HTTP2_') ||
    code.startsWith('ERR_QUIC_') ||
    code === 'ERR_TIMED_OUT' ||
    code === 'ERR_EMPTY_RESPONSE' ||
    code === 'ERR_SOCKET_NOT_CONNECTED' ||
    code === 'ERR_TOO_MANY_REDIRECTS' ||
    code === 'ERR_INVALID_HTTP_RESPONSE' ||
    code === 'ERR_CONTENT_LENGTH_MISMATCH' ||
    code === 'ERR_INCOMPLETE_CHUNKED_ENCODING' ||
    code === 'ERR_NO_SUPPORTED_PROXIES' ||
    code === 'ERR_BLOCKED_BY_CLIENT' ||
    code === 'ERR_ABORTED'
  )
}

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const pushUnique = (list: string[], value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return
  if (list.includes(trimmed)) return
  list.push(trimmed)
}

const collectErrorParts = (value: unknown, seen: WeakSet<object>, into: CollectedErrorParts) => {
  if (value == null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    pushUnique(into.texts, String(value))
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  const record = value as Record<string, unknown>
  if (value instanceof Error) {
    pushUnique(into.texts, value.name)
    pushUnique(into.texts, value.message)
  }

  pushUnique(into.texts, toSafeString(record.message))
  pushUnique(into.texts, toSafeString(record.name))

  const code = toSafeString(record.code)
  if (code) {
    pushUnique(into.codes, code.toUpperCase())
    pushUnique(into.texts, code)
  }
  const errno = toSafeString(record.errno)
  if (errno) {
    pushUnique(into.codes, errno.toUpperCase())
    pushUnique(into.texts, errno)
  }

  const statusCode = record.statusCode ?? record.status
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    into.statusCodes.push(statusCode)
  }

  collectErrorParts(record.cause, seen, into)
  collectErrorParts(record.error, seen, into)
  collectErrorParts(record.description, seen, into)
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      collectErrorParts(nested, seen, into)
    }
  }
}

const extractChromiumNetCodes = (texts: string[]): string[] => {
  const codes: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(/net::(ERR_[A-Z0-9_]+)/g)) {
      pushUnique(codes, match[1].toUpperCase())
    }
  }
  return codes
}

const classifyChromiumNetCode = (code: string): UpdateNetworkReason => {
  if (
    code.includes('PROXY') ||
    code.includes('TUNNEL') ||
    code.includes('SOCKS') ||
    code === 'ERR_NO_SUPPORTED_PROXIES'
  ) {
    return 'proxy'
  }
  if (code.includes('CERT') || code.includes('SSL') || code.includes('TLS')) {
    return 'tls'
  }
  if (
    code === 'ERR_NAME_NOT_RESOLVED' ||
    code.includes('DNS') ||
    code === 'ERR_NAME_RESOLUTION_FAILED'
  ) {
    return 'dns'
  }
  if (
    code === 'ERR_INTERNET_DISCONNECTED' ||
    code === 'ERR_ADDRESS_UNREACHABLE' ||
    code === 'ERR_NETWORK_CHANGED' ||
    code === 'ERR_NETWORK_ACCESS_DENIED' ||
    code === 'ERR_ADDRESS_INVALID'
  ) {
    return 'offline'
  }
  if (code.includes('TIMED_OUT') || code === 'ERR_CONNECTION_TIMED_OUT') {
    return 'timeout'
  }
  if (code === 'ERR_CONNECTION_REFUSED') {
    return 'connection-refused'
  }
  if (
    code === 'ERR_CONNECTION_RESET' ||
    code === 'ERR_CONNECTION_ABORTED' ||
    code === 'ERR_CONNECTION_CLOSED' ||
    code === 'ERR_EMPTY_RESPONSE' ||
    code === 'ERR_SOCKET_NOT_CONNECTED'
  ) {
    return 'connection-reset'
  }
  return 'generic'
}

const classifyNodeCode = (code: string): UpdateNetworkReason | null => {
  if (TLS_CODES.has(code)) return 'tls'
  if (!NODE_NETWORK_CODES.has(code) && !code.startsWith('ERR_NETWORK')) return null
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ENETRESET'
  ) {
    return 'connection-reset'
  }
  if (code === 'ECONNREFUSED') return 'connection-refused'
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETDOWN' ||
    code === 'EHOSTDOWN' ||
    code === 'ERR_INTERNET_DISCONNECTED'
  ) {
    return 'offline'
  }
  return 'generic'
}

const joinedText = (texts: string[]): string => texts.join('\n')

const isSignatureFailure = (normalized: string): boolean =>
  normalized.includes('code signature') ||
  normalized.includes('did not pass validation') ||
  normalized.includes('not signed') ||
  normalized.includes('未签名') ||
  normalized.includes('shipit') ||
  normalized.includes('err_updater_invalid_signature')

const isInstallFailure = (normalized: string, codes: string[]): boolean => {
  if (codes.includes('EACCES') || codes.includes('EPERM')) return true
  return (
    normalized.includes('failed to install') ||
    normalized.includes('cannot install') ||
    normalized.includes('error while installing') ||
    normalized.includes('access denied') ||
    normalized.includes('permission denied') ||
    normalized.includes('read-only volume')
  )
}

const isGenericNetworkText = (normalized: string): UpdateNetworkReason | null => {
  if (normalized.includes('socket hang up') || normalized.includes('econnreset')) {
    return 'connection-reset'
  }
  if (normalized.includes('enotfound') || normalized.includes('getaddrinfo')) {
    return 'dns'
  }
  if (
    normalized.includes('etimedout') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout of') ||
    normalized.includes('aborted due to timeout')
  ) {
    return 'timeout'
  }
  if (
    normalized.includes('internet disconnected') ||
    normalized.includes('network is unreachable')
  ) {
    return 'offline'
  }
  if (
    normalized.includes('proxy') &&
    (normalized.includes('fail') || normalized.includes('error'))
  ) {
    return 'proxy'
  }
  if (normalized.includes('fetch failed') || normalized.includes('network error')) {
    return 'generic'
  }
  if (normalized.includes('aborterror') || normalized.includes('the operation was aborted')) {
    return 'generic'
  }
  return null
}

export const classifyUpdateError = (error: unknown): UpdateErrorClassification => {
  const parts: CollectedErrorParts = { texts: [], codes: [], statusCodes: [] }
  collectErrorParts(error, new WeakSet(), parts)
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : parts.texts[0] || String(error || '')
  const normalized = joinedText(parts.texts).toLowerCase()
  const chromiumCodes = extractChromiumNetCodes(parts.texts)
  const allCodes = [...chromiumCodes]
  for (const code of parts.codes) {
    pushUnique(allCodes, code)
  }

  if (isSignatureFailure(normalized)) {
    return { kind: 'signature', code: allCodes[0] || null, message }
  }
  if (isInstallFailure(normalized, allCodes)) {
    return { kind: 'install', code: allCodes[0] || null, message }
  }

  if (chromiumCodes.length > 0) {
    const code = chromiumCodes[0]
    return {
      kind: 'network',
      code,
      networkReason: classifyChromiumNetCode(code),
      message
    }
  }

  for (const code of allCodes) {
    if (isChromiumNetCode(code)) {
      return {
        kind: 'network',
        code,
        networkReason: classifyChromiumNetCode(code),
        message
      }
    }
    const networkReason = classifyNodeCode(code)
    if (networkReason) {
      return { kind: 'network', code, networkReason, message }
    }
  }

  const unavailableStatus = parts.statusCodes.find((status) => HTTP_UNAVAILABLE_STATUS.has(status))
  if (typeof unavailableStatus === 'number') {
    return {
      kind: 'network',
      code: `HTTP_${unavailableStatus}`,
      networkReason: 'http-unavailable',
      message
    }
  }
  if (parts.statusCodes.includes(403)) {
    return {
      kind: 'network',
      code: 'HTTP_403',
      networkReason: 'http-unavailable',
      message
    }
  }

  const textReason = isGenericNetworkText(normalized)
  if (textReason) {
    return { kind: 'network', code: allCodes[0] || null, networkReason: textReason, message }
  }

  const firstStatus = parts.statusCodes[0]
  return {
    kind: 'unknown',
    code: allCodes[0] || (typeof firstStatus === 'number' ? `HTTP_${firstStatus}` : null),
    message
  }
}

export const isTransientUpdateNetworkError = (error: unknown): boolean =>
  classifyUpdateError(error).kind === 'network'

export const logIfUnexpectedUpdateError = (tag: string, error: unknown, extra?: unknown) => {
  const classified = classifyUpdateError(error)
  if (classified.kind === 'network') return classified
  if (extra === undefined) {
    log.error(tag, classified, error)
  } else {
    log.error(tag, extra, classified, error)
  }
  return classified
}

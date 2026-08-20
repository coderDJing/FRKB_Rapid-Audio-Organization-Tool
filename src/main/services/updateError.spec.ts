import { describe, expect, it } from 'vitest'
import { classifyUpdateError, isTransientUpdateNetworkError } from './updateError'

describe('classifyUpdateError', () => {
  it('把 Chromium 连接重置识别为网络问题', () => {
    const classified = classifyUpdateError(new Error('net::ERR_CONNECTION_RESET'))
    expect(classified).toMatchObject({
      kind: 'network',
      code: 'ERR_CONNECTION_RESET',
      networkReason: 'connection-reset'
    })
    expect(isTransientUpdateNetworkError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true)
  })

  it('区分超时、DNS、代理和证书错误', () => {
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT')).networkReason).toBe('timeout')
    expect(classifyUpdateError(new Error('net::ERR_NAME_NOT_RESOLVED')).networkReason).toBe('dns')
    expect(classifyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED')).networkReason).toBe(
      'proxy'
    )
    expect(classifyUpdateError(new Error('net::ERR_CERT_AUTHORITY_INVALID')).networkReason).toBe(
      'tls'
    )
  })

  it('能从嵌套 cause 里取出 Chromium 网络码', () => {
    const error = Object.assign(new Error('Cannot download latest.yml'), {
      cause: new Error('net::ERR_CONNECTION_RESET')
    })
    expect(classifyUpdateError(error)).toMatchObject({
      kind: 'network',
      code: 'ERR_CONNECTION_RESET',
      networkReason: 'connection-reset'
    })
  })

  it('把 Node / undici 网络码识别为网络问题', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(classifyUpdateError(reset)).toMatchObject({
      kind: 'network',
      code: 'ECONNRESET',
      networkReason: 'connection-reset'
    })
    expect(classifyUpdateError(new Error('socket hang up')).kind).toBe('network')
    expect(classifyUpdateError(new Error('fetch failed')).kind).toBe('network')
  })

  it('把 GitHub 短暂不可用的 HTTP 状态当成网络问题', () => {
    const error = Object.assign(new Error('Request failed'), { statusCode: 503 })
    expect(classifyUpdateError(error)).toMatchObject({
      kind: 'network',
      code: 'HTTP_503',
      networkReason: 'http-unavailable'
    })
    expect(
      classifyUpdateError(Object.assign(new Error('rate limited'), { statusCode: 403 })).kind
    ).toBe('network')
  })

  it('也能识别没有 net:: 前缀的 Chromium error.code', () => {
    const error = Object.assign(new Error('failed to check for updates'), {
      code: 'ERR_CONNECTION_RESET'
    })
    expect(classifyUpdateError(error)).toMatchObject({
      kind: 'network',
      code: 'ERR_CONNECTION_RESET',
      networkReason: 'connection-reset'
    })
  })

  it('不会把安装包文件名或清单 404 误判成安装失败/网络失败', () => {
    expect(classifyUpdateError(new Error('Cannot download FRKB-Setup.exe')).kind).toBe('unknown')
    expect(isTransientUpdateNetworkError(new Error('Cannot download FRKB-Setup.exe'))).toBe(false)
  })

  it('清单缺失视为安装包已下架，签名/安装失败仍视为真实错误', () => {
    expect(
      classifyUpdateError(Object.assign(new Error('Not Found'), { statusCode: 404 })).kind
    ).toBe('gone')
    expect(classifyUpdateError(Object.assign(new Error('Gone'), { statusCode: 410 })).kind).toBe(
      'gone'
    )
    expect(
      isTransientUpdateNetworkError(Object.assign(new Error('Not Found'), { statusCode: 404 }))
    ).toBe(false)
    expect(classifyUpdateError(new Error('Code signature did not pass validation')).kind).toBe(
      'signature'
    )
    expect(
      classifyUpdateError(Object.assign(new Error('permission denied'), { code: 'EACCES' })).kind
    ).toBe('install')
    expect(
      isTransientUpdateNetworkError(new Error('Unable to find latest version on GitHub'))
    ).toBe(false)
  })
})

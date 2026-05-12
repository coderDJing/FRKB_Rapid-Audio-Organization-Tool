import { is } from '@electron-toolkit/utils'
import { fetchWithSystemProxy } from './fetchWithSystemProxy'
import { log } from './log'

const DISCOVERY_URL = process.env.CLOUD_SYNC_DISCOVERY_URL || ''
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 分钟

const DEFAULT_BASE_URL = is.dev
  ? process.env.CLOUD_SYNC_BASE_URL_DEV || 'http://localhost:3001'
  : process.env.CLOUD_SYNC_BASE_URL_PROD || ''

let cachedBaseUrl: string | null = null
let cacheExpiresAt = 0

/**
 * 从 Gist 发现服务器地址，带内存缓存和回退。
 * Gist 内容格式：{"baseUrl":"http://xxx"}
 * 解析失败或不可达时回退到构建时写死的默认地址。
 */
export async function resolveBaseUrl(): Promise<string> {
  const now = Date.now()
  if (cachedBaseUrl && now < cacheExpiresAt) {
    return cachedBaseUrl
  }

  // 没有配置发现地址，直接用默认
  if (!DISCOVERY_URL) {
    return DEFAULT_BASE_URL
  }

  try {
    const res = await fetchWithSystemProxy(DISCOVERY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) {
      log.warn('[serverDiscovery] discovery request failed', { status: res.status })
      return fallback()
    }
    const json = await res.json()
    const discovered = typeof json?.baseUrl === 'string' ? json.baseUrl.trim() : ''
    if (!discovered) {
      log.warn('[serverDiscovery] discovery response missing baseUrl', { json })
      return fallback()
    }
    cachedBaseUrl = discovered
    cacheExpiresAt = now + CACHE_TTL_MS
    log.info('[serverDiscovery] resolved base url from discovery', { baseUrl: discovered })
    return discovered
  } catch (e) {
    log.warn('[serverDiscovery] discovery request error, using default', { error: e })
    return fallback()
  }
}

function fallback(): string {
  // 不缓存回退值，下次仍会重试发现
  cacheExpiresAt = 0
  return DEFAULT_BASE_URL
}

import { is } from '@electron-toolkit/utils'
import { fetchWithSystemProxy } from './fetchWithSystemProxy'

const DISCOVERY_URL = process.env.CLOUD_SYNC_DISCOVERY_URL || ''

const DEFAULT_BASE_URL = is.dev
  ? process.env.CLOUD_SYNC_BASE_URL_DEV || 'http://localhost:3001'
  : process.env.CLOUD_SYNC_BASE_URL_PROD || ''

/**
 * 从线上发现文件解析服务器地址。
 * 每次操作开始时重新获取，避免服务器迁移后继续请求旧地址。
 * 内容格式：{"baseUrl":"http://xxx"}
 */
export async function resolveBaseUrl(): Promise<string> {
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
      return fallback()
    }
    const json = await res.json()
    const discovered = typeof json?.baseUrl === 'string' ? json.baseUrl.trim() : ''
    if (!discovered) {
      return fallback()
    }
    return discovered
  } catch {
    return fallback()
  }
}

function fallback(): string {
  return DEFAULT_BASE_URL
}

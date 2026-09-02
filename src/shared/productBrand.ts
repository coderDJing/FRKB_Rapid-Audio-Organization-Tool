/** 用户可见产品名。安装身份、userData、可执行文件名仍为 frkb / FRKB，不得随此改。 */
export const PRODUCT_DISPLAY_NAME = 'Track Studio'
export const PRODUCT_FORMER_NAME = 'FRKB'
export const DEFAULT_LIBRARY_FOLDER_NAME = 'TrackStudioLibrary'
export const GITHUB_OWNER = 'coderDJing'
export const GITHUB_REPO = 'Track-Studio'
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`
export const GITHUB_PAGES_URL = `https://coderDJing.github.io/${GITHUB_REPO}/`
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`
export const GITHUB_RELEASES_LATEST_URL = `${GITHUB_RELEASES_URL}/latest`
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
export const GITHUB_RELEASES_LATEST_API_URL = `${GITHUB_RELEASES_API_URL}/latest`
export const GITHUB_RAW_SERVER_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/server.json`
export const GITHUB_THIRD_PARTY_NOTICES_URL = `${GITHUB_REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`

export const buildGithubReleaseDownloadUrl = (releaseTag: string, fileName: string): string =>
  `${GITHUB_REPO_URL}/releases/download/${releaseTag}/${fileName}`

export const buildProductUserAgent = (version: string): string =>
  `TrackStudio/${version} (formerly ${PRODUCT_FORMER_NAME}; ${GITHUB_PAGES_URL})`

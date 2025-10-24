// i18n 基础
const I18N = { current: 'zh', dict: null }
let LATEST_VERSION = ''
// 主题状态
const THEME = { current: 'dark' }

function getInitialLang() {
  const saved = localStorage.getItem('lang')
  if (saved === 'en' || saved === 'zh') return saved
  return /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

async function loadI18n(lang) {
  const res = await fetch(`./i18n/${lang}.json`)
  if (!res.ok) return // 不兜底
  I18N.dict = await res.json()
  I18N.current = lang
}

function applyI18n() {
  if (!I18N.dict) return
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    const val = key.split('.').reduce((o, k) => (o ? o[k] : undefined), I18N.dict)
    if (typeof val === 'string') el.textContent = val // 缺失则不替换
  })
  const langToggle = document.getElementById('langToggle')
  if (langToggle) langToggle.textContent = I18N.current.toUpperCase()
  const themeToggle = document.getElementById('themeToggle')
  if (themeToggle) {
    const title = I18N.current === 'zh' ? '切换主题' : 'Toggle theme'
    themeToggle.title = title
    themeToggle.setAttribute('aria-label', title)
  }
}

function updateDownloadLabels() {
  const heroWin = document.getElementById('heroWin')
  const heroMac = document.getElementById('heroMac')
  const winLabel = heroWin ? heroWin.querySelector('.label') : null
  const macLabel = heroMac ? heroMac.querySelector('.label') : null

  const lang = I18N.current === 'en' ? 'en' : 'zh'
  const v = LATEST_VERSION && typeof LATEST_VERSION === 'string' ? LATEST_VERSION : ''

  if (winLabel) {
    winLabel.textContent =
      lang === 'zh'
        ? v
          ? `下载FRKB ${v} (Windows)`
          : '下载FRKB (Windows)'
        : v
          ? `Download FRKB ${v} (Windows)`
          : 'Download FRKB (Windows)'
  }
  if (macLabel) {
    macLabel.textContent =
      lang === 'zh'
        ? v
          ? `下载FRKB ${v} (macOS)`
          : '下载FRKB (macOS)'
        : v
          ? `Download FRKB ${v} (macOS)`
          : 'Download FRKB (macOS)'
  }
}

async function initI18n() {
  const lang = getInitialLang()
  await loadI18n(lang)
  applyI18n()
  // 主图随语言切换
  const img = document.getElementById('heroImg')
  if (img) {
    img.src =
      I18N.current === 'zh'
        ? './assets/softwareScreenshot_cn.webp'
        : './assets/softwareScreenshot.webp'
    img.alt = I18N.current === 'zh' ? 'FRKB 主界面' : 'FRKB main UI'
  }
  const langToggle = document.getElementById('langToggle')
  if (langToggle) {
    langToggle.addEventListener('click', async () => {
      const next = I18N.current === 'zh' ? 'en' : 'zh'
      localStorage.setItem('lang', next)
      await loadI18n(next)
      applyI18n()
      updateDownloadLabels()
      if (img) {
        img.src =
          I18N.current === 'zh'
            ? './assets/softwareScreenshot_cn.webp'
            : './assets/softwareScreenshot.webp'
        img.alt = I18N.current === 'zh' ? 'FRKB 主界面' : 'FRKB main UI'
      }
    })
  }
}

// 主题：暗色默认；支持系统偏好与本地持久化
function getInitialTheme() {
  const saved = localStorage.getItem('theme')
  if (saved === 'light' || saved === 'dark') return saved
  const preferLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches
  return preferLight ? 'light' : 'dark'
}

function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
  THEME.current = theme
  // 使用内联 SVG，不再覆盖按钮文本
}

function initTheme() {
  const t = getInitialTheme()
  applyTheme(t)
  const btn = document.getElementById('themeToggle')
  if (btn) {
    btn.addEventListener('click', () => {
      const next = THEME.current === 'light' ? 'dark' : 'light'
      localStorage.setItem('theme', next)
      applyTheme(next)
    })
  }
}

// 下载按钮：仅 Windows 与 macOS（不做 OS 自动识别、不做兜底）
const OWNER = 'coderDJing'
const REPO = 'FRKB_Rapid-Audio-Organization-Tool'

// OS 识别（仅区分 Windows 与 macOS）
function detectOS() {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  return 'unknown'
}

function pickAsset(assets, matchFn) {
  const exclude = (n) => /\.(blockmap|ya?ml|txt|sha\d*)$/i.test(n)
  const candidates = assets.filter((a) => a?.name && !exclude(a.name) && matchFn(a.name))
  return candidates[0] || null
}

async function initDownloadButtons() {
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
  const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) return // 不兜底
  const data = await res.json()
  const assets = data.assets || []

  const win = pickAsset(assets, (n) => /win.*\.(exe|msi)$/i.test(n))
  const mac = pickAsset(
    assets,
    (n) => /\.(dmg|pkg|zip)$/i.test(n) && /(mac|osx|darwin|universal|arm64|x64)/i.test(n)
  )

  const winBtn = document.getElementById('winBtn')
  const macBtn = document.getElementById('macBtn')
  const heroWin = document.getElementById('heroWin')
  const heroMac = document.getElementById('heroMac')
  const ctaPanel = document.querySelector('.cta-panel')
  const ctaSkeleton = document.getElementById('ctaSkeleton')
  const toggle = document.getElementById('togglePlatform')
  if (win && winBtn) winBtn.href = win.browser_download_url
  if (mac && macBtn) macBtn.href = mac.browser_download_url
  if (win && heroWin) heroWin.href = win.browser_download_url
  if (mac && heroMac) heroMac.href = mac.browser_download_url

  // 将最新版本号追加到首屏按钮文案
  let version = data?.tag_name || data?.name || ''
  if (typeof version === 'string' && version.trim()) {
    version = /^v/i.test(version) ? version : `v${version}`
    LATEST_VERSION = version
    updateDownloadLabels()
  }

  // Hero 区自动判断 OS，仅展示对应按钮（对齐 VS Code 行为）
  const os = detectOS()
  const cta = document.querySelector('.cta')
  if (os === 'windows') {
    if (heroWin) heroWin.style.display = 'inline-block'
    if (heroMac) heroMac.style.display = 'none'
    if (ctaPanel) ctaPanel.style.display = ''
  } else if (os === 'mac') {
    if (heroWin) heroWin.style.display = 'none'
    if (heroMac) heroMac.style.display = 'inline-block'
    if (ctaPanel) ctaPanel.style.display = ''
  } else {
    // 未识别则都显示，保持可选
    if (heroWin) heroWin.style.display = 'inline-block'
    if (heroMac) heroMac.style.display = 'inline-block'
    if (ctaPanel) ctaPanel.style.display = ''
  }

  // 统一切换逻辑：点击“其他平台”在两平台间切换
  if (toggle) {
    toggle.onclick = (e) => {
      e.preventDefault()
      if (!heroWin || !heroMac) return
      const winVisible = heroWin.style.display !== 'none'
      const macVisible = heroMac.style.display !== 'none'
      if (winVisible && !macVisible) {
        heroWin.style.display = 'none'
        heroMac.style.display = 'inline-block'
      } else if (!winVisible && macVisible) {
        heroWin.style.display = 'inline-block'
        heroMac.style.display = 'none'
      } else {
        // 若都显示，则切到 macOS 以保持单显示
        heroWin.style.display = 'none'
        heroMac.style.display = 'inline-block'
      }
    }
  }

  // 隐藏骨架
  if (ctaSkeleton) ctaSkeleton.remove()

  // 顶部公告条：显示最新版本名与链接
  const bar = document.getElementById('updateBar')
  const text = document.getElementById('updateText')
  const link = document.getElementById('updateLink')
  if (data && data.html_url && data.name && bar && text && link) {
    text.textContent = I18N.current === 'zh' ? '最新正式版：' : 'Latest release:'
    link.textContent = data.name
    link.href = data.html_url
    bar.hidden = false
  }
}

// 启动
;(async function main() {
  // 主题优先应用，避免首次闪烁
  try {
    initTheme()
  } catch {}
  // 恢复 i18n：根据浏览器语言加载字典并渲染
  try {
    await initI18n()
  } catch {}
  const img = document.getElementById('heroImg')
  if (img) {
    const useZh = (I18N?.current || 'zh') === 'zh'
    img.src = useZh ? './assets/softwareScreenshot_cn.webp' : './assets/softwareScreenshot.webp'
    img.alt = useZh ? 'FRKB 主界面' : 'FRKB main UI'
  }
  await initDownloadButtons()

  // 绑定图片预览（主图与特性图）
  const modal = document.getElementById('imgModal')
  const modalImg = document.getElementById('imgModalImg')
  const openModal = (src, alt) => {
    if (!modal || !modalImg) return
    modalImg.src = src
    modalImg.alt = alt || ''
    modal.classList.add('show')
    document.body.classList.add('modal-open')
  }
  const closeModal = () => {
    if (!modal) return
    modal.classList.remove('show')
    document.body.classList.remove('modal-open')
  }
  if (img) img.addEventListener('click', () => openModal(img.src, img.alt))
  document.querySelectorAll('.card .shot').forEach((el) => {
    el.addEventListener('click', () => openModal(el.src, el.alt))
  })
  if (modal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal()
    })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal()
  })
})()

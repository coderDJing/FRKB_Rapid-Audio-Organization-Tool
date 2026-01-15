<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useData, withBase } from 'vitepress'

const { localeIndex, site } = useData()
const isEn = ref(localeIndex.value === 'en')

// 监听语言切换
onMounted(() => {
  isEn.value = window.location.pathname.includes('/en/')
})

// 主题切换逻辑
const theme = ref('dark')

const toggleTheme = () => {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', theme.value)
  applyTheme(theme.value)
}

const applyTheme = (t) => {
  const root = document.documentElement
  if (t === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
}

// 鼠标光效逻辑
const glowRef = ref(null)
const handleMouseMove = (e) => {
  if (glowRef.value) {
    glowRef.value.style.left = e.clientX + 'px'
    glowRef.value.style.top = e.clientY + 'px'
    glowRef.value.style.opacity = '1'
  }
}

onMounted(() => {
  // 初始化主题
  const savedTheme = localStorage.getItem('theme') || 'dark'
  theme.value = savedTheme
  applyTheme(savedTheme)

  // 初始化下载按钮
  initDownloadButtons()

  window.addEventListener('mousemove', handleMouseMove)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
})

// 下载相关状态
const showWin = ref(false)
const showMac = ref(false)
const winUrl = ref('#')
const macUrl = ref('#')
const version = ref('')
const isLoadingDownloads = ref(true)

// 初始化下载按钮
const initDownloadButtons = async () => {
  try {
    const api =
      'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'
    const res = await fetch(api)
    if (!res.ok) throw new Error('Failed to fetch')

    const data = await res.json()
    const assets = data.assets || []

    const win = assets.find((a) => /win.*\.(exe|msi)$/i.test(a.name))
    const mac = assets.find(
      (a) =>
        /\.(dmg|pkg|zip)$/i.test(a.name) && /(mac|osx|darwin|universal|arm64|x64)/i.test(a.name)
    )

    if (win) winUrl.value = win.browser_download_url
    if (mac) macUrl.value = mac.browser_download_url

    if (data.tag_name) {
      version.value = data.tag_name.startsWith('v') ? data.tag_name : `v${data.tag_name}`
    }

    // 检测操作系统
    const ua = navigator.userAgent
    const isWin = /Windows/i.test(ua)
    const isMac = /Macintosh|Mac OS X/i.test(ua)

    if (isWin) {
      showWin.value = true
      showMac.value = false
    } else if (isMac) {
      showWin.value = false
      showMac.value = true
    } else {
      showWin.value = true
      showMac.value = true
    }
  } catch (err) {
    console.error('Failed to load download links:', err)
    showWin.value = true
    showMac.value = true
  } finally {
    isLoadingDownloads.value = false
  }
}

// 切换平台显示
const togglePlatform = (e) => {
  e.preventDefault()
  const winHidden = !showWin.value
  showWin.value = winHidden
  showMac.value = !winHidden
}

const zhFeatures = [
  {
    title: '键盘优先的人机工学',
    details: '大幅减少鼠标移动与点击，所有高频操作均可通过快捷键完成。',
    img: '/assets/shortcutKey_cn.webp'
  },
  {
    title: '内容感知去重',
    details: '基于音频指纹技术，精准识别内容重复的文件。',
    img: '/assets/import_cn.webp'
  },
  {
    title: '所见即所得的映射',
    details: '界面上的分组与目录即是真实的磁盘结构，同步生效。',
    img: '/assets/mappingRelation_cn.webp'
  },
  {
    title: '云端同步与便携',
    details: '支持 SHA256 指纹双向云同步，数据库轻量便携。',
    icon: 'cloud'
  },
  {
    title: '全局人机工学快键',
    details: '支持全局播放控制，即使应用最小化也能快速切歌。',
    icon: 'keyboard'
  },
  {
    title: 'BPM 与调性分析',
    details: '精准分析曲目速度与调性，支持 Tap Tempo 手动修正。',
    icon: 'analysis'
  }
]

const enFeatures = [
  {
    title: 'Keyboard-First Ergonomics',
    details: 'Minimize mouse movement. All frequent operations are accessible via shortcuts.',
    img: '/assets/shortcutKey.webp'
  },
  {
    title: 'Content-Aware Dedup',
    details: 'Identify duplicates based on audio characteristics.',
    img: '/assets/import.webp'
  },
  {
    title: 'WYSIWYG Mapping',
    details: 'UI groups and directories reflect the true disk structure.',
    img: '/assets/mappingRelation.webp'
  },
  {
    title: 'Cloud Sync & Portability',
    details: 'SHA256-based fingerprint sync for secure backups.',
    icon: 'cloud'
  },
  {
    title: 'Global & Ergonomic Shortcuts',
    details: 'Full playback control even when minimized.',
    icon: 'keyboard'
  },
  {
    title: 'BPM & Key Analysis',
    details: 'Precise analysis with Tap Tempo support.',
    icon: 'analysis'
  }
]
</script>

<template>
  <div class="custom-home-wrapper">
    <!-- 鼠标光效 -->
    <div ref="glowRef" class="mouse-glow"></div>

    <!-- 导航栏 (找回之前的设计) -->
    <nav class="nav">
      <div class="container nav-inner">
        <a class="brand" :href="withBase('/')">
          <img :src="withBase('/assets/icon.webp')" alt="FRKB" style="width: 32px; height: 32px" />
          FRKB
        </a>
        <div class="nav-left">
          <a href="#features">{{ isEn ? 'Features' : '特性' }}</a>
          <a href="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool" target="_blank"
            >GitHub</a
          >
        </div>
        <div class="nav-right">
          <button
            @click="toggleTheme"
            class="theme-toggle"
            :aria-label="isEn ? 'Toggle theme' : '切换主题'"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="5" />
              <path
                d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
              />
            </svg>
          </button>
          <a :href="withBase(isEn ? '/' : '/en/')" class="lang-toggle">{{
            isEn ? '中文' : 'EN'
          }}</a>
        </div>
      </div>
    </nav>

    <!-- Hero Section -->
    <header class="hero">
      <div class="container hero-inner">
        <h1 class="reveal is-visible">
          <template v-if="!isEn">符合人机工学的<br /><span>开源音频快速整理工具</span></template>
          <template v-else>Ergonomic<br /><span>Fast Audio Organization Tool</span></template>
        </h1>
        <p class="subtitle reveal is-visible">
          {{
            isEn
              ? 'Built for audio professionals seeking ultimate efficiency. Content-aware dedup and WYSIWYG file mapping.'
              : '专为追求极致效率的音频工作者打造。内容感知去重，所见即所得的文件映射。'
          }}
        </p>

        <div class="cta reveal is-visible">
          <!-- 加载骨架屏 -->
          <div v-if="isLoadingDownloads" class="cta-skeleton">
            <div class="sk-btn"></div>
          </div>

          <!-- 下载按钮 -->
          <div v-else class="cta-panel">
            <a v-if="showWin" class="download-btn" :href="winUrl" target="_blank" rel="nofollow">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path
                  d="M0 3.449L9.75 2.1V11.7H0V3.449zm0 17.1L9.75 21.9V12.3H0v8.249zM10.5 1.8L24 0v11.7H10.5V1.8zm0 20.4L24 24V12.3H10.5v9.9z"
                />
              </svg>
              <span class="label">
                {{
                  isEn
                    ? version
                      ? `Download for Windows ${version}`
                      : 'Download for Windows'
                    : version
                      ? `下载 Windows 版 ${version}`
                      : '下载 Windows 版'
                }}
              </span>
            </a>

            <a v-if="showMac" class="download-btn" :href="macUrl" target="_blank" rel="nofollow">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path
                  d="M17.057 12.781c.032 2.588 2.254 3.462 2.287 3.477-.025.065-.338 1.15-1.118 2.273-.679.973-1.381 1.94-2.486 1.96-1.087.02-1.391-.651-2.629-.651-1.241 0-1.609.63-2.67.67-.1.04-1.766-.02-2.527-1.12-1.554-2.245-2.657-6.333-1.055-9.09.795-1.373 2.215-2.248 3.76-2.268 1.171-.025 2.212.748 2.927.748.717 0 1.98-.923 3.342-.782.572.022 2.181.23 3.213 1.731-.082.051-1.922 1.112-1.902 3.33zm-2.404-7.334c.615-.747 1.026-1.783.912-2.821-.892.036-1.972.593-2.612 1.341-.571.659-1.072 1.716-.938 2.731.996.078 2.016-.491 2.638-1.251z"
                />
              </svg>
              <span class="label">
                {{
                  isEn
                    ? version
                      ? `Download for macOS ${version}`
                      : 'Download for macOS'
                    : version
                      ? `下载 macOS 版 ${version}`
                      : '下载 macOS 版'
                }}
              </span>
            </a>
          </div>

          <!-- 其他平台按钮 -->
          <a v-if="!isLoadingDownloads" href="#" @click="togglePlatform" class="toggle-platform">
            {{ isEn ? 'Other Platforms' : '其他平台' }}
          </a>
        </div>

        <div class="hero-media reveal is-visible">
          <div class="hero-frame">
            <img
              class="hero-img"
              :src="
                withBase(
                  isEn ? '/assets/softwareScreenshot.webp' : '/assets/softwareScreenshot_cn.webp'
                )
              "
              alt="FRKB UI"
            />
          </div>
        </div>
      </div>
    </header>

    <!-- Features Section -->
    <section id="features" class="features">
      <div class="container">
        <div class="features-header reveal is-visible">
          <h2>{{ isEn ? 'Key Features' : '核心特性' }}</h2>
        </div>
        <div class="grid">
          <div
            class="card reveal is-visible"
            v-for="f in isEn ? enFeatures : zhFeatures"
            :key="f.title"
          >
            <h3>{{ f.title }}</h3>
            <p>{{ f.details }}</p>
            <div class="shot-container">
              <img v-if="f.img" :src="withBase(f.img)" :alt="f.title" class="shot" />
              <div v-else class="placeholder-shot">
                <svg
                  v-if="f.icon === 'cloud'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                >
                  <path
                    d="M17.5 19c.6 0 1.2-.1 1.7-.3 1.1-.5 1.8-1.6 1.8-2.7 0-1.2-.8-2.2-1.9-2.5-.1-3.1-2.7-5.5-5.8-5.5-2.1 0-4 1.1-5 2.8-.2-.1-.5-.1-.8-.1-2.1 0-3.7 1.7-3.7 3.8s1.6 3.8 3.7 3.8h10z"
                  />
                </svg>
                <svg
                  v-if="f.icon === 'keyboard'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                >
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M7 16h10" />
                </svg>
                <svg
                  v-if="f.icon === 'analysis'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 2v20M2 12h20" />
                </svg>
                <span>{{ isEn ? 'Waiting for upload...' : '等待截图上传...' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Specs Section -->
    <section class="specs">
      <div class="container">
        <div class="specs-grid">
          <div>
            <h2>{{ isEn ? 'System Requirements' : '系统要求' }}</h2>
            <ul>
              <li>{{ isEn ? 'Windows 10 or later (x64)' : 'Windows 10 或更高版本 (x64)' }}</li>
              <li>{{ isEn ? 'macOS 12 or later' : 'macOS 12 或更高版本' }}</li>
            </ul>
          </div>
          <div>
            <h2>{{ isEn ? 'Supported Formats' : '支持格式' }}</h2>
            <p>
              {{
                isEn
                  ? 'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
                  : 'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
              }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <footer class="footer">
      <div class="container">
        <small>© 2026 FRKB Project. Crafted for Excellence.</small>
      </div>
    </footer>
  </div>
</template>

<style scoped>
@import './custom.css';

.custom-home-wrapper {
  min-height: 100vh;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.mouse-glow {
  position: fixed;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(var(--accent-rgb), 0.08), transparent 70%);
  border-radius: 50%;
  pointer-events: none;
  z-index: -1;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 1s cubic-bezier(0.16, 1, 0.3, 1);
}

.footer {
  padding: 60px 0;
  text-align: center;
  border-top: 1px solid var(--glass-border);
  color: var(--muted);
}
</style>

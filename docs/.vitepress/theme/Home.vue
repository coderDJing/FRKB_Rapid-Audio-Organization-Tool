<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { localeIndex } = useData()
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
const latestReleasePage =
  'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'
const winUrl = ref(latestReleasePage)
const macUrl = ref(latestReleasePage)
const version = ref('')
const isLoadingDownloads = ref(true)

const findAssetUrl = (assets, matchers) => {
  for (const matcher of matchers) {
    const match = assets.find((asset) => matcher.test(asset.name))
    if (match?.browser_download_url) return match.browser_download_url
  }
  return ''
}

// 初始化下载按钮
const initDownloadButtons = async () => {
  try {
    const api =
      'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'
    const res = await fetch(api)
    if (!res.ok) throw new Error('Failed to fetch')

    const data = await res.json()
    const assets = data.assets || []
    const releaseUrl =
      typeof data.html_url === 'string' && data.html_url ? data.html_url : latestReleasePage

    winUrl.value = findAssetUrl(assets, [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i]) || releaseUrl
    macUrl.value = findAssetUrl(assets, [/\.dmg$/i, /\.pkg$/i, /\.zip$/i]) || releaseUrl

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

const zhContent = {
  nav: [
    { label: '特性', href: '#features' },
    { label: '工作流', href: '#workflow' }
  ],
  hero: {
    titleTop: '符合人机工学的',
    titleBottom: '开源音频快速整理工具',
    subtitle:
      '从内容感知去重、真实文件映射、波形试听，到 Mixtape 自动录制、Stem 分轨、Pioneer U 盘库、全局搜歌与格式转换，一套桌面应用把音频整理和后续处理串起来。'
  },
  featuresIntro: {
    title: '核心能力',
    description: '整理、分析、试听、录制准备和导出都在同一套流程里，不需要来回换工具。'
  },
  features: [
    {
      title: '键盘优先的人机工学',
      details: '大幅减少鼠标移动与点击，所有高频操作均可通过快捷键完成。'
    },
    {
      title: '内容感知去重',
      details: '基于音频指纹技术，精准识别内容重复的文件。'
    },
    {
      title: '所见即所得的映射',
      details: '界面上的分组与目录即是真实的磁盘结构，同步生效。'
    },
    {
      title: '波形试听与筛歌',
      details: '支持 SoundCloud、细节与 RGB 波形，配合区间播放和列表预览快速筛歌。'
    },
    {
      title: 'BPM 与调性分析',
      details: '精准分析曲目速度与调性，支持 Tap Tempo 手动修正。'
    },
    {
      title: '元数据与封面',
      details: '支持标签整理、封面替换与 MusicBrainz / AcoustID 自动补齐。'
    },
    {
      title: 'Mixtape 自动录制',
      details: '独立时间线工作台用于排录制、听效果、调参数并直接导出结果。'
    },
    {
      title: 'Stem 分轨运行时',
      details: '支持按需下载、缓存和加速运行时，把分轨准备和导出接入主流程。'
    },
    {
      title: 'Pioneer U 盘库',
      details: '支持 Device Library 与 OneLibrary 浏览、歌单树、预览波形和只读预听。'
    },
    {
      title: '全局搜歌与格式转换',
      details: '全局搜歌、定位反馈和独立格式转换工具都已收进桌面端入口。'
    },
    {
      title: '闲时分析调度',
      details: '后台分析统一走闲时调度与限流，尽量少抢前台操作资源。'
    },
    {
      title: '云端同步与便携',
      details: '支持 SHA256 指纹双向云同步，数据库轻量便携。'
    }
  ],
  workflowIntro: {
    title: '完整工作流',
    description: '导入、判断、准备、输出一路顺下来，功能都是围着实际音频整理场景收拢的。'
  },
  workflow: [
    {
      step: '01',
      title: '导入本地库或设备库',
      details: '拖拽导入本地目录，或者直接读取 Pioneer U 盘库，把素材先拉进统一工作区。'
    },
    {
      step: '02',
      title: '搜歌、试听、分析',
      details: '用全局搜歌、波形试听、BPM / 调性分析和快捷键，快速完成筛选与判断。'
    },
    {
      step: '03',
      title: '准备自动录制与分轨',
      details: '在 Mixtape 时间线里调整包络与节拍，或运行 Stem 分轨把素材准备干净。'
    },
    {
      step: '04',
      title: '转换、导出并回写结果',
      details: '格式转换、导出文件、移动歌单与目录映射都会稳稳落回真实文件系统。'
    }
  ],
  specs: {
    title: '系统要求',
    systems: ['Windows 10 或更高版本 (x64)', 'macOS 12 或更高版本', '暂无 Linux 正式版'],
    formatsTitle: '支持格式',
    formats:
      'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
  }
}

const enContent = {
  nav: [
    { label: 'Features', href: '#features' },
    { label: 'Workflow', href: '#workflow' }
  ],
  hero: {
    titleTop: 'Ergonomic',
    titleBottom: 'Fast Audio Organization Tool',
    subtitle:
      'Content-aware dedup, true file mapping, waveform-driven preview, Mixtape auto-recording, stem separation, Pioneer USB libraries, global search, and format conversion all live inside one desktop workflow.'
  },
  featuresIntro: {
    title: 'Core Capabilities',
    description:
      'Organization, analysis, preview, recording prep, and export are all handled inside one consistent workflow.'
  },
  features: [
    {
      title: 'Keyboard-First Ergonomics',
      details: 'Minimize mouse movement. All frequent operations are accessible via shortcuts.'
    },
    {
      title: 'Content-Aware Dedup',
      details: 'Identify duplicates based on audio characteristics.'
    },
    {
      title: 'WYSIWYG Mapping',
      details: 'UI groups and directories reflect the true disk structure.'
    },
    {
      title: 'Waveform Preview',
      details: 'SoundCloud, detailed, and RGB waveforms with range playback keep screening fast.'
    },
    {
      title: 'BPM & Key Analysis',
      details: 'Precise analysis with Tap Tempo support.'
    },
    {
      title: 'Metadata & Artwork',
      details:
        'Tag cleanup, cover replacement, and MusicBrainz / AcoustID assisted metadata filling.'
    },
    {
      title: 'Mixtape Auto-Recording',
      details:
        'A dedicated timeline workspace for arranging, previewing, tweaking, and exporting mixes.'
    },
    {
      title: 'Managed Stem Runtime',
      details:
        'On-demand runtime downloads, caching, and acceleration keep stem prep inside the app.'
    },
    {
      title: 'Pioneer USB Libraries',
      details:
        'Browse Device Library and OneLibrary data with playlist trees, preview waveforms, and guarded preview.'
    },
    {
      title: 'Global Search & Conversion',
      details:
        'Global search, locate feedback, and a standalone format conversion tool are built in.'
    },
    {
      title: 'Idle Analysis Scheduling',
      details: 'Background analysis runs through unified idle scheduling and throttling.'
    },
    {
      title: 'Cloud Sync & Portability',
      details: 'SHA256-based fingerprint sync for secure backups and portable library state.'
    }
  ],
  workflowIntro: {
    title: 'Complete Workflow',
    description:
      'Import, decide, prepare, and export in one pass. The product is shaped around real audio-organization work.'
  },
  workflow: [
    {
      step: '01',
      title: 'Import local or device libraries',
      details: 'Drag in local folders or read Pioneer USB libraries inside the same workspace.'
    },
    {
      step: '02',
      title: 'Search, preview, analyze',
      details:
        'Use global search, waveform preview, BPM/key analysis, and shortcuts to make decisions quickly.'
    },
    {
      step: '03',
      title: 'Prepare recording and stems',
      details: 'Shape the Mixtape timeline or run stem separation before output.'
    },
    {
      step: '04',
      title: 'Convert, export, write back',
      details:
        'Format conversion, export, playlist movement, and file mapping all land back on the real file system.'
    }
  ],
  specs: {
    title: 'System Requirements',
    systems: ['Windows 10 or later (x64)', 'macOS 12 or later', 'No official Linux build yet'],
    formatsTitle: 'Supported Formats',
    formats:
      'MP3, WAV, FLAC, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
  }
}

const pageContent = computed(() => (isEn.value ? enContent : zhContent))
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
          <a v-for="item in pageContent.nav" :key="item.href" :href="item.href">{{ item.label }}</a>
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
          {{ pageContent.hero.titleTop }}<br /><span>{{ pageContent.hero.titleBottom }}</span>
        </h1>
        <p class="subtitle reveal is-visible">
          {{ pageContent.hero.subtitle }}
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
                  theme === 'light'
                    ? isEn
                      ? '/assets/softwareScreenshot_light.webp'
                      : '/assets/softwareScreenshot_cn_light.webp'
                    : isEn
                      ? '/assets/softwareScreenshot.webp'
                      : '/assets/softwareScreenshot_cn.webp'
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
          <h2>{{ pageContent.featuresIntro.title }}</h2>
          <p>{{ pageContent.featuresIntro.description }}</p>
        </div>
        <div class="grid">
          <div class="card reveal is-visible" v-for="f in pageContent.features" :key="f.title">
            <h3>{{ f.title }}</h3>
            <p>{{ f.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <section id="workflow" class="workflow">
      <div class="container">
        <div class="workflow-header reveal is-visible">
          <h2>{{ pageContent.workflowIntro.title }}</h2>
          <p>{{ pageContent.workflowIntro.description }}</p>
        </div>
        <div class="workflow-grid">
          <div
            class="card workflow-card reveal is-visible"
            v-for="item in pageContent.workflow"
            :key="item.step"
          >
            <span class="workflow-step">{{ item.step }}</span>
            <h3>{{ item.title }}</h3>
            <p>{{ item.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Specs Section -->
    <section class="specs">
      <div class="container">
        <div class="specs-grid">
          <div>
            <h2>{{ pageContent.specs.title }}</h2>
            <ul>
              <li v-for="item in pageContent.specs.systems" :key="item">{{ item }}</li>
            </ul>
          </div>
          <div>
            <h2>{{ pageContent.specs.formatsTitle }}</h2>
            <p>{{ pageContent.specs.formats }}</p>
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

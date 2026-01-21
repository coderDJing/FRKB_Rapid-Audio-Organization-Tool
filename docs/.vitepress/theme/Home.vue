<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
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

// 功能特性配置 - 仅文字展示
const zhFeatures = [
  {
    title: '键盘优先效率',
    details: '高频操作可通过快捷键完成，减少鼠标移动。'
  },
  {
    title: '指纹去重',
    details: '导入与歌单一键去重，支持内容指纹/文件哈希两种模式。'
  },
  {
    title: '真实文件映射',
    details: '界面分组与磁盘目录同步，所见即所得整理。'
  },
  {
    title: '波形与试听',
    details: '三种波形样式与列表预览，支持播放区间快速筛歌。'
  },
  {
    title: 'BPM 与调性分析',
    details: '后台分析 BPM/调性，Tap Tempo 手动校正。'
  },
  {
    title: '元数据与封面',
    details: '标签编辑、封面替换与另存，支持 MusicBrainz/AcoustID。'
  }
]

const enFeatures = [
  {
    title: 'Keyboard-First Efficiency',
    details: 'Frequent actions are mapped to shortcuts to reduce mouse travel.'
  },
  {
    title: 'Fingerprint Dedup',
    details: 'Import and playlist dedup with content-fingerprint or file-hash modes.'
  },
  {
    title: 'WYSIWYG File Mapping',
    details: 'On-screen structure mirrors real folders for true file-level organization.'
  },
  {
    title: 'Waveform-Driven Preview',
    details: 'Three waveform styles plus list previews with playback range.'
  },
  {
    title: 'BPM & Key Analysis',
    details: 'Background BPM/key analysis with Tap Tempo correction.'
  },
  {
    title: 'Metadata & Artwork',
    details: 'Edit tags and covers with MusicBrainz/AcoustID auto-fill.'
  }
]

const zhWorkflow = [
  {
    title: '建库与目录映射',
    details: '选择库位置，筛选库/精选库自动生成并与磁盘同步。'
  },
  {
    title: '拖拽导入 + 去重策略',
    details: '导入时可选指纹库去重/批次去重与“导入后删除原文件”。'
  },
  {
    title: '快速试听与筛选',
    details: '波形预览、BPM/调性与快捷键帮助你快速做决定。'
  },
  {
    title: '移动/导出/回收',
    details: '移动到精选、导出到文件夹或回收站，目录结构同步更新。'
  }
]

const enWorkflow = [
  {
    title: 'Create Library & Map Folders',
    details: 'Choose a library location; Filter/Curated libraries are created and synced to disk.'
  },
  {
    title: 'Drag in & Choose Dedup',
    details: 'Pick fingerprint-library or batch-only dedup, plus optional delete-after-import.'
  },
  {
    title: 'Preview & Decide Fast',
    details: 'Waveform preview, BPM/Key, and shortcuts speed up screening.'
  },
  {
    title: 'Move, Export, Recycle',
    details: 'Move to Curated, export to a folder, or use the Recycle Bin—disk stays in sync.'
  }
]

const zhMatrix = [
  {
    title: '指纹与去重',
    items: [
      '内容指纹/文件哈希两种模式',
      '导入去重: 指纹库/仅本批',
      '歌单一键去重',
      '批量分析与手动添加指纹',
      '指纹库导入/导出 + 云同步(需 key)'
    ]
  },
  {
    title: '库与整理',
    items: [
      '筛选库/精选库双库流程',
      '真实文件映射, 目录同步',
      '拖拽导入与拖拽移动',
      '外拖复制到资源管理器/Finder',
      '导出到文件夹, 可选导出后删除',
      '回收站还原与彻底删除',
      '库目录变更自动同步'
    ]
  },
  {
    title: '试听与分析',
    items: [
      'BPM/调性后台分析',
      'Tap Tempo 手动校正',
      'Classic/Camelot 调性显示',
      '播放区间选择',
      '自动续播下一曲',
      '输出设备选择'
    ]
  },
  {
    title: '波形与视图',
    items: [
      'SoundCloud/Fine/RGB 波形样式',
      '半/全波形切换',
      '列表波形预览列',
      '列拖拽排序/显隐/宽度',
      '文本/时长/BPM 筛选',
      '筛选条件可持久化'
    ]
  },
  {
    title: '元数据与封面',
    items: [
      '曲目信息编辑',
      '封面替换与封面另存',
      'MusicBrainz 搜索匹配',
      'AcoustID 指纹匹配',
      '批量自动填充'
    ]
  },
  {
    title: '格式转换',
    items: ['批量转换多种格式', '新文件/替换原文件', '保留元数据', '可选添加指纹库']
  },
  {
    title: '系统集成与维护',
    items: [
      '外部曲目临时播放, 不导入也可试听',
      '在资源管理器/Finder 中显示',
      'Windows 右键菜单“在 FRKB 中播放”',
      '全局快捷键',
      '更新检查与提示',
      '扫描格式可配置',
      '中英文界面'
    ]
  }
]

const enMatrix = [
  {
    title: 'Fingerprint & Dedup',
    items: [
      'Content fingerprint / file-hash modes',
      'Import dedup: library or batch-only',
      'One-click playlist dedup',
      'Batch analyze or manual add fingerprints',
      'Export/import fingerprint DB + cloud sync (key required)'
    ]
  },
  {
    title: 'Libraries & Organization',
    items: [
      'Filter/Curated dual-library flow',
      'WYSIWYG file mapping with disk sync',
      'Drag-in import and drag-to-move',
      'Drag out copies to Explorer/Finder',
      'Export to folder with optional delete',
      'Recycle Bin restore / permanent delete',
      'Auto sync on library folder changes'
    ]
  },
  {
    title: 'Playback & Analysis',
    items: [
      'Background BPM/key analysis',
      'Tap Tempo correction',
      'Classic/Camelot display',
      'Playback range selection',
      'Auto play next',
      'Output device selection'
    ]
  },
  {
    title: 'Waveform & View',
    items: [
      'SoundCloud / Fine / RGB waveforms',
      'Half / full waveform modes',
      'List waveform preview column',
      'Columns drag-reorder / hide / resize',
      'Text, duration, BPM filters',
      'Filters can persist across restarts'
    ]
  },
  {
    title: 'Metadata & Artwork',
    items: [
      'Edit track metadata',
      'Replace and save cover art',
      'MusicBrainz search',
      'AcoustID fingerprint match',
      'Batch auto-fill'
    ]
  },
  {
    title: 'Format Conversion',
    items: [
      'Batch convert to many formats',
      'New file or replace original',
      'Preserve metadata',
      'Optionally add fingerprints'
    ]
  },
  {
    title: 'System & Maintenance',
    items: [
      'External tracks for temporary playback',
      'Open in Explorer/Finder',
      'Windows context menu: Play in FRKB',
      'Global shortcuts',
      'Update checks & prompts',
      'Configurable scan formats',
      'Chinese/English UI'
    ]
  }
]

const zhFaq = [
  {
    q: 'FRKB 会上传音频吗？',
    a: '不会。云同步只同步 SHA256 指纹，不上传音频与标签。'
  },
  {
    q: '需要联网吗？',
    a: '本地整理/播放/去重可离线使用；元数据自动填充、云同步、更新检查需要联网。'
  },
  {
    q: '指纹模式有什么区别？',
    a: '内容指纹基于音频内容，文件哈希基于文件本体，适用场景不同。'
  },
  {
    q: 'AcoustID Key 怎么用？',
    a: '在设置中填写个人 Client Key，可提升匹配稳定性并避免公共限速。'
  },
  {
    q: '有 Linux 版本吗？',
    a: '暂无 Linux 正式版。'
  },
  {
    q: '自动更新如何工作？',
    a: '内置检查与提示，下载与安装由你确认。'
  }
]

const enFaq = [
  {
    q: 'Does FRKB upload my audio?',
    a: 'No. Cloud Sync only syncs SHA256 fingerprints, not audio or tags.'
  },
  {
    q: 'Do I need internet?',
    a: 'Local organization/playback/dedup work offline. MusicBrainz/AcoustID, Cloud Sync, and update checks need a connection.'
  },
  {
    q: 'What’s the difference between fingerprint modes?',
    a: 'Content fingerprints are based on audio content; file hash uses the file itself. They serve different dedup needs.'
  },
  {
    q: 'How do I use an AcoustID key?',
    a: 'Add your Client Key in Settings to improve matching and avoid public rate limits.'
  },
  {
    q: 'Is there a Linux build?',
    a: 'No official Linux build yet.'
  },
  {
    q: 'How do updates work?',
    a: 'FRKB checks for updates and shows prompts; downloads are confirmed by you.'
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
          <a href="#workflow">{{ isEn ? 'Workflow' : '流程' }}</a>
          <a href="#faq">{{ isEn ? 'FAQ' : '常见问题' }}</a>
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
              ? 'Built for audio pros who value speed: keyboard-first workflows, fingerprint dedup, and true file mapping.'
              : '为追求效率的音频工作者而生：键盘优先、指纹去重、所见即所得的文件整理。'
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
            {{ isEn ? 'Switch Platform' : '切换平台' }}
          </a>
          <p v-if="!isLoadingDownloads" class="cta-note">
            {{
              isEn
                ? 'Windows and macOS only. No Linux build yet.'
                : '仅支持 Windows 与 macOS，暂无 Linux 版本。'
            }}
          </p>
          <p v-if="!isLoadingDownloads" class="cta-note">
            {{
              isEn
                ? 'Built-in update checks with manual download confirmation.'
                : '内置更新检查与提示，下载需你确认。'
            }}
          </p>
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
          <h2>{{ isEn ? 'Key Features' : '核心特性' }}</h2>
          <p>
            {{
              isEn
                ? 'From import and dedup to preview and export, every step stays fast and file-true.'
                : '从导入、去重到试听与导出，每一步都保持高效且文件级同步。'
            }}
          </p>
        </div>
        <div class="grid">
          <div
            class="card reveal is-visible"
            v-for="f in isEn ? enFeatures : zhFeatures"
            :key="f.title"
          >
            <h3>{{ f.title }}</h3>
            <p>{{ f.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Workflow Section -->
    <section id="workflow" class="workflow">
      <div class="container">
        <div class="section-header reveal is-visible">
          <h2>{{ isEn ? 'A Workflow Built for Speed' : '为速度而生的流程' }}</h2>
          <p>
            {{
              isEn
                ? 'Four steps cover the full lifecycle: import, preview, decide, and ship.'
                : '四步完成一轮筛歌：导入、试听、决策、输出。'
            }}
          </p>
        </div>
        <div class="workflow-grid">
          <div
            class="workflow-card reveal is-visible"
            v-for="(step, index) in isEn ? enWorkflow : zhWorkflow"
            :key="step.title"
          >
            <div class="workflow-step">
              {{ isEn ? `Step ${index + 1}` : `步骤 ${index + 1}` }}
            </div>
            <h3>{{ step.title }}</h3>
            <p>{{ step.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Matrix Section -->
    <section id="matrix" class="matrix">
      <div class="container">
        <div class="section-header reveal is-visible">
          <h2>{{ isEn ? 'Capability Matrix' : '能力矩阵' }}</h2>
          <p>
            {{
              isEn
                ? 'Everything you need to clean, analyze, and organize audio—without leaving the app.'
                : '从去重、试听到整理与导出，你需要的能力都在这里。'
            }}
          </p>
        </div>
        <div class="matrix-grid">
          <div
            class="matrix-card reveal is-visible"
            v-for="group in isEn ? enMatrix : zhMatrix"
            :key="group.title"
          >
            <h3>{{ group.title }}</h3>
            <ul>
              <li v-for="item in group.items" :key="item">{{ item }}</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ Section -->
    <section id="faq" class="faq">
      <div class="container">
        <div class="section-header reveal is-visible">
          <h2>{{ isEn ? 'FAQ & Transparency' : 'FAQ 与透明说明' }}</h2>
          <p>
            {{
              isEn
                ? 'Clear answers about syncing, privacy, and platform support.'
                : '关于同步、隐私与平台支持的明确说明。'
            }}
          </p>
        </div>
        <div class="faq-grid">
          <div
            class="faq-item reveal is-visible"
            v-for="item in isEn ? enFaq : zhFaq"
            :key="item.q"
          >
            <h3>{{ item.q }}</h3>
            <p>{{ item.a }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Specs Section -->
    <section id="specs" class="specs">
      <div class="container">
        <div class="specs-grid">
          <div>
            <h2>{{ isEn ? 'System Requirements' : '系统要求' }}</h2>
            <ul>
              <li>{{ isEn ? 'Windows 10 or later (x64)' : 'Windows 10 或更高版本 (x64)' }}</li>
              <li>{{ isEn ? 'macOS 12 or later' : 'macOS 12 或更高版本' }}</li>
              <li>{{ isEn ? 'No official Linux build yet' : '暂无 Linux 正式版' }}</li>
            </ul>
          </div>
          <div>
            <h2>{{ isEn ? 'Supported Formats' : '支持格式' }}</h2>
            <p>
              {{
                isEn
                  ? 'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
                  : 'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV'
              }}
            </p>
            <p class="specs-note">
              {{
                isEn ? 'Scan formats can be configured in Settings.' : '扫描格式可在设置中配置。'
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

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

// 滚动侦测逻辑
const observer = ref(null)

onMounted(() => {
  // 初始化主题
  const savedTheme = localStorage.getItem('theme') || 'dark'
  theme.value = savedTheme
  applyTheme(savedTheme)

  // 初始化下载按钮
  initDownloadButtons()

  window.addEventListener('mousemove', handleMouseMove)

  // 设置 IntersectionObserver
  observer.value = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          // 可选：如果希望动画只触发一次，可以取消观察
          // observer.value.unobserve(entry.target)
        }
      })
    },
    {
      root: null,
      threshold: 0.15,
      rootMargin: '0px 0px -50px 0px'
    }
  )

  // 观察所有需要动画的元素
  setTimeout(() => {
    document.querySelectorAll('.reveal').forEach((el) => {
      observer.value.observe(el)
    })
  }, 100)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
  if (observer.value) {
    observer.value.disconnect()
  }
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
  nav: [{ label: '特性', href: '#features' }],
  hero: {
    titleTop: '终结混乱的',
    titleBottom: 'DJ 音频工作站',
    subtitle:
      '不再需要在多个软件间疲于奔命。从指纹去重、波形试听、Rekordbox 库无缝集成，到 Mixtape 自动录制与 AI 分轨，FRKB 用极速的键盘操作，为你打造一站式、所见即所得的桌面音频整理引擎。'
  },
  impacts: [
    {
      id: 'dual-deck',
      title: '双轨横推模式',
      subtitle: '类 DJ 混音台的并排浏览与试听',
      details:
        '支持独立音量推子、交叉渐变、Hot Cue、Memory Cue、Loop、Quantize 和调性高亮。快速判断两首歌是否和谐匹配。',
      image: '/assets/softwareScreenshot_cn.webp',
      imageLight: '/assets/softwareScreenshot_cn_light.webp'
    },
    {
      id: 'mixtape-stem',
      title: 'Mixtape 自动录制与 Stem 分轨',
      subtitle: '为演出准备完美的素材',
      details:
        '独立时间线工作台用于排录制、听效果、调参数并直接导出结果。支持跨窗口拖入与跨轨道拖拽定位。内置受管 Stem 运行时，把分轨准备接入主流程。',
      image: '/assets/mixtapeScreenshot_cn.webp',
      imageLight: '/assets/mixtapeScreenshot_cn_light.webp'
    }
  ],
  coreFeatures: [
    {
      title: '单轨编辑与波形可视化',
      details:
        '支持 SoundCloud、细节、RGB 以及单轨编辑模式波形，配合区间播放和列表预览快速筛歌。精准定位高潮段落与鼓点能量。'
    },
    {
      title: '内容感知去重与真实映射',
      details:
        '基于音频指纹技术，精准识别内容重复的文件。界面上的分组与目录即是真实的磁盘结构，同步生效，告别重复与混乱。'
    },
    {
      title: 'Rekordbox & Pioneer 生态接入',
      details:
        '直接读取本机 Rekordbox 库与歌单，支持拖拽排序、Cue/Loop 读取和 XML 一次性导出。支持 Pioneer U 盘库直接读取与预览。'
    },
    {
      title: '键盘优先的人机工学',
      details:
        '大幅减少鼠标移动与点击，所有高频操作均可通过快捷键完成，保护肩颈，让整理操作更加流畅和高效。'
    }
  ],
  bentoFeaturesIntro: {
    title: '极客特性',
    description: '为高级用户准备的强大工具集。'
  },
  bentoFeatures: [
    {
      title: '智能节拍网格与分析',
      details: '精准分析曲目速度与调性，支持 Tap Tempo 手动修正。'
    },
    {
      title: '全能格式转换与元数据',
      details: '支持标签整理、封面替换与 MusicBrainz 自动补齐。非 MP3 格式一键转换。'
    },
    {
      title: '跨设备云同步',
      details: '支持 SHA256 指纹双向云同步，精选表演者自动拆分联动，数据库轻量便携。'
    },
    {
      title: '筛选库与精选库双层架构',
      details: '专为 DJ 打造的双库分流体系，配合快捷键快速筛选，贴合真实的选曲与沉淀习惯。'
    },
    {
      title: '安全的回收站机制',
      details:
        '所有的删除与去重操作均进入专属回收站，支持一键恢复到原歌单，让大批量整理毫无后顾之忧。'
    },
    {
      title: '智能批量重命名',
      details: '支持按预设规则或自定义格式统一修改歌单内文件名，保持音乐库命名绝对一致性。'
    },
    {
      title: '全局搜歌与双源发现',
      details: '支持跨界面搜歌、网易云网页搜索和相似歌曲双源查询。'
    },
    {
      title: '闲时分析调度',
      details: '后台分析统一走闲时调度与限流，保障前台操作绝对流畅。'
    },
    {
      title: '代码开源与透明',
      details: '核心代码完全开源，接受社区监督。架构清晰，欢迎开发者共同参与贡献。'
    },
    {
      title: '无缝在线更新',
      details: '内置自动更新机制，第一时间获取最新功能与修复，始终保持最佳工作状态。'
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
  nav: [{ label: 'Features', href: '#features' }],
  hero: {
    titleTop: 'End the Chaos.',
    titleBottom: 'The Ultimate DJ Audio Workspace.',
    subtitle:
      'Stop bouncing between apps. From fingerprint dedup, waveform preview, and seamless Rekordbox integration, to Mixtape auto-recording and AI stems. FRKB delivers an all-in-one, WYSIWYG desktop engine powered by lightning-fast keyboard ergonomics.'
  },
  impacts: [
    {
      id: 'dual-deck',
      title: 'Dual-Deck Browse Mode',
      subtitle: 'DJ mixer-style side-by-side browsing',
      details:
        'Supports volume faders, crossfader, Hot Cue, Memory Cue, Loop, Quantize, and key highlighting. Quickly judge if two tracks match perfectly.',
      image: '/assets/softwareScreenshot.webp',
      imageLight: '/assets/softwareScreenshot_light.webp'
    },
    {
      id: 'mixtape-stem',
      title: 'Mixtape Auto-Recording & Stems',
      subtitle: 'Prepare perfect materials for your set',
      details:
        'A dedicated timeline workspace for arranging, previewing, tweaking, and exporting mixes. Supports cross-window drag-in. Managed Stem runtime keeps track separation inside the app.',
      image: '/assets/mixtapeScreenshot.webp',
      imageLight: '/assets/mixtapeScreenshot_light.webp'
    }
  ],
  coreFeatures: [
    {
      title: 'Waveform Edit & Visualization',
      details:
        'SoundCloud, detailed, RGB, and single-track editing waveforms with range playback. Precisely locate drops and drum energy.'
    },
    {
      title: 'Content-Aware Dedup & Mapping',
      details:
        'Identify duplicates based on audio characteristics. UI groups and directories reflect the true disk structure. Say goodbye to duplicates and mess.'
    },
    {
      title: 'Rekordbox & Pioneer Integration',
      details:
        'Directly read local Rekordbox libraries and playlists with drag-to-reorder, Cue/Loop reading, and one-click XML export. Browse Pioneer USB libraries directly.'
    },
    {
      title: 'Keyboard-First Ergonomics',
      details:
        'Minimize mouse movement. All frequent operations are accessible via shortcuts, protecting your neck and making organization fluid.'
    }
  ],
  bentoFeaturesIntro: {
    title: 'Geek Features',
    description: 'Powerful toolset for advanced users.'
  },
  bentoFeatures: [
    {
      title: 'Smart Beatgrid & Analysis',
      details: 'Precise BPM and key analysis with Tap Tempo support.'
    },
    {
      title: 'Format Conversion & Metadata',
      details:
        'Tag cleanup, cover replacement, and MusicBrainz assisted filling. One-click non-MP3 conversion.'
    },
    {
      title: 'Cross-Device Cloud Sync',
      details:
        'SHA256-based fingerprint sync, curated artist split-linking, and portable library state.'
    },
    {
      title: 'Dual-Library Architecture',
      details:
        'Dedicated Screening and Curated libraries designed for DJs. Quickly route tracks with shortcuts.'
    },
    {
      title: 'Safe Recycle Bin',
      details:
        'All deletions and dedups go to a dedicated recycle bin with one-click restore. Organize with peace of mind.'
    },
    {
      title: 'Smart Batch Rename',
      details:
        'Unify filenames across playlists using preset rules or custom formats for absolute consistency.'
    },
    {
      title: 'Global Search & Discovery',
      details: 'Global search, NetEase Cloud search, and dual-source similar track discovery.'
    },
    {
      title: 'Idle Analysis Scheduling',
      details:
        'Background analysis runs through unified idle scheduling to guarantee absolute UI fluidity.'
    },
    {
      title: 'Open Source & Transparent',
      details:
        'Core code is fully open-source. Clear architecture welcomes community contributions.'
    },
    {
      title: 'Seamless Auto-Updates',
      details: 'Built-in update mechanism ensures you always have the latest features and fixes.'
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
            class="theme-toggle"
            :aria-label="isEn ? 'Toggle theme' : '切换主题'"
            @click="toggleTheme"
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
        <h1 class="reveal">
          {{ pageContent.hero.titleTop }}<br /><span>{{ pageContent.hero.titleBottom }}</span>
        </h1>
        <p class="subtitle reveal">
          {{ pageContent.hero.subtitle }}
        </p>

        <div class="cta reveal">
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
          <a v-if="!isLoadingDownloads" href="#" class="toggle-platform" @click="togglePlatform">
            {{ isEn ? 'Other Platforms' : '其他平台' }}
          </a>
        </div>
      </div>
    </header>

    <!-- 视觉震撼区 (Visual Impacts) -->
    <section id="features" class="impacts-section">
      <div
        v-for="(impact, index) in pageContent.impacts"
        :key="impact.id"
        class="impact-block reveal"
        :class="{ reverse: index % 2 !== 0 }"
      >
        <div class="container">
          <div class="impact-inner">
            <div class="impact-text">
              <h2>{{ impact.title }}</h2>
              <h3>{{ impact.subtitle }}</h3>
              <p>{{ impact.details }}</p>
            </div>
            <div class="impact-media">
              <div class="hero-frame">
                <img
                  class="hero-img"
                  :src="withBase(theme === 'light' ? impact.imageLight : impact.image)"
                  :alt="impact.title"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 核心整理痛点区 (Core Features) -->
    <section class="core-features-section">
      <div class="container">
        <div class="core-grid">
          <div
            class="core-card reveal"
            v-for="(feature, index) in pageContent.coreFeatures"
            :key="index"
          >
            <div class="core-icon">
              <!-- 这里可以用简单的数字或SVG占位 -->
              <span>0{{ index + 1 }}</span>
            </div>
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.details }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 极客特性便当盒 (Bento Grid) -->
    <section class="bento-section">
      <div class="container">
        <div class="bento-header reveal">
          <h2>{{ pageContent.bentoFeaturesIntro.title }}</h2>
          <p>{{ pageContent.bentoFeaturesIntro.description }}</p>
        </div>
        <div class="bento-grid">
          <div
            class="bento-card reveal"
            v-for="(bento, index) in pageContent.bentoFeatures"
            :key="index"
            :class="`bento-item-${index + 1}`"
          >
            <h3>{{ bento.title }}</h3>
            <p>{{ bento.details }}</p>
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

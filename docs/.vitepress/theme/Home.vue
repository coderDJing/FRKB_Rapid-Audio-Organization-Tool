<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { localeIndex } = useData()
const isEn = computed(() => String(localeIndex.value || '') === 'en')

const theme = ref('dark')
const glowRef = ref(null)
const currentYear = new Date().getFullYear()

const latestReleaseApi =
  'https://api.github.com/repos/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'
const latestReleasePage =
  'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases/latest'

const showWin = ref(false)
const showMac = ref(false)
const winUrl = ref(latestReleasePage)
const macUrl = ref(latestReleasePage)
const version = ref('')
const isLoadingDownloads = ref(true)

const applyTheme = (nextTheme) => {
  const root = document.documentElement
  if (nextTheme === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
}

const toggleTheme = () => {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', theme.value)
  applyTheme(theme.value)
}

const handleMouseMove = (event) => {
  if (!glowRef.value) return
  glowRef.value.style.left = `${event.clientX}px`
  glowRef.value.style.top = `${event.clientY}px`
  glowRef.value.style.opacity = '1'
}

const findAssetUrl = (assets, matchers) => {
  for (const matcher of matchers) {
    const match = assets.find((asset) => matcher.test(asset.name))
    if (match?.browser_download_url) return match.browser_download_url
  }
  return ''
}

const resolveWindowsDownloadUrl = (assets) =>
  findAssetUrl(assets, [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i])

const resolveMacDownloadUrl = (assets) => findAssetUrl(assets, [/\.dmg$/i, /\.pkg$/i, /\.zip$/i])

const initDownloadButtons = async () => {
  try {
    const response = await fetch(latestReleaseApi)
    if (!response.ok) throw new Error('Failed to fetch latest release')

    const data = await response.json()
    const assets = data.assets || []
    const releaseUrl =
      typeof data.html_url === 'string' && data.html_url ? data.html_url : latestReleasePage

    winUrl.value = resolveWindowsDownloadUrl(assets) || releaseUrl
    macUrl.value = resolveMacDownloadUrl(assets) || releaseUrl
    version.value = data.tag_name
      ? data.tag_name.startsWith('v')
        ? data.tag_name
        : `v${data.tag_name}`
      : ''

    const userAgent = navigator.userAgent
    const detectedWin = /Windows/i.test(userAgent)
    const detectedMac = /Macintosh|Mac OS X/i.test(userAgent)

    if (detectedWin) {
      showWin.value = true
      showMac.value = false
      return
    }

    if (detectedMac) {
      showWin.value = false
      showMac.value = true
      return
    }

    showWin.value = true
    showMac.value = true
  } catch (error) {
    console.error('Failed to load release assets:', error)
    showWin.value = true
    showMac.value = true
  } finally {
    isLoadingDownloads.value = false
  }
}

const togglePlatform = (event) => {
  event.preventDefault()
  const nextWinVisible = !showWin.value
  showWin.value = nextWinVisible
  showMac.value = !nextWinVisible
}

const zhContent = {
  nav: [
    { label: '核心特性', href: '#features' },
    { label: '新功能', href: '#new-features' },
    { label: '工作流', href: '#workflow' },
    { label: 'FAQ', href: '#faq' }
  ],
  hero: {
    kicker: '开源桌面音频工作流',
    titleTop: '符合人机工学的',
    titleBottom: '开源音频快速整理工具',
    description:
      'FRKB 还是那个以键盘效率、指纹去重和真实文件映射为核心的整理工具，只把最近补上的 Mixtape 自动录制、Stem 分轨、Pioneer U 盘库这些新能力集中说明清楚。',
    pills: ['键盘优先', '内容指纹去重', '真实文件映射'],
    notes: [
      '支持 Windows 与 macOS，下载按钮会自动优先匹配当前平台。',
      '下方“新功能说明”只补最近新增模块，不再把首页堆成一坨功能墙。'
    ],
    releasesLabel: '查看 Releases'
  },
  featuresIntro: {
    kicker: '核心特性',
    title: '旧版的主干体验还在',
    description: '导入、试听、去重、整理、导出这些高频动作，还是按最顺手的节奏来。'
  },
  features: [
    {
      title: '键盘优先效率',
      details: '高频操作可通过快捷键完成，减少鼠标来回折返。'
    },
    {
      title: '指纹去重',
      details: '导入去重、歌单去重和指纹库维护都能跑，支持内容指纹与文件哈希两种模式。'
    },
    {
      title: '真实文件映射',
      details: '界面里的筛选库、精选库和磁盘目录保持同步，整理结果直接落在真实文件系统里。'
    },
    {
      title: '波形与试听',
      details: 'SoundCloud、细节波形、RGB 波形和列表预览都在，扫歌速度不会掉。'
    },
    {
      title: 'BPM / 调性分析',
      details: '后台分析 BPM 和调性，Tap Tempo 还能手动修正，数据不是死的。'
    },
    {
      title: '元数据与封面',
      details: '标签编辑、封面替换与另存、MusicBrainz / AcoustID 自动补齐都能接上。'
    }
  ],
  newFeaturesIntro: {
    kicker: '新功能说明',
    title: '最近新增的能力，只补说明不改调性',
    description:
      '官网视觉恢复成之前这套克制样子，新功能单独放一节讲明白，够看就行，不再拿首页做功能展销会。'
  },
  newFeatures: [
    {
      title: 'Mixtape 自动录制',
      description:
        '新增独立自动录制工作台，把排时间线、听效果、改参数、导出这一串动作收进同一块界面。',
      bullets: [
        '双轨时间线、节拍对齐波形、首拍分析',
        '节拍器、BPM 草稿保存、时间线缩放与跟随',
        '增益 / BPM 包络、段落静音、撤销和导出一致性'
      ]
    },
    {
      title: 'Stem 分轨运行时',
      description: 'Stem 能力不再是零散按钮，而是完整的运行时管理链路，包含缓存、预热和按需下载。',
      bullets: [
        'Demucs 运行时管理与缓存',
        'ONNX fast 分离与 DirectML / XPU 加速',
        '缺啥下啥，避免主安装包继续发胖'
      ]
    },
    {
      title: 'Pioneer U 盘库',
      description: '现在可以直接浏览 Pioneer 设备库，不必再只围着本地库转，真实 DJ 场景顺手很多。',
      bullets: [
        '支持 Device Library 与 OneLibrary 两条链路',
        '歌单树、预览波形、只读预听和播放入口',
        '多盘识别、设备弹出与入口分组'
      ]
    },
    {
      title: '搜歌、转换与闲时分析',
      description: '顺手补了几个高频入口，找歌、转格式和后台分析不再东一榔头西一棒槌。',
      bullets: [
        '全局搜歌入口与更稳定的定位反馈',
        '独立格式转换工具',
        '统一闲时调度与空闲限流，后台分析更稳'
      ]
    }
  ],
  workflowIntro: {
    kicker: '工作流',
    title: '四步走完一轮音频整理',
    description: '导入、判断、处理、落盘，流程还是之前那种直接、不绕。'
  },
  workflow: [
    {
      step: '01',
      title: '导入本地库或设备库',
      description: '拖拽导入本地文件夹，或者接入 Pioneer U 盘库，把素材先收进同一条链路。'
    },
    {
      step: '02',
      title: '试听、搜歌、分析',
      description: '用波形预览、全局搜歌、BPM / 调性分析和快捷键，快速做筛选判断。'
    },
    {
      step: '03',
      title: '做自动录制或分轨准备',
      description: '进 Mixtape 时间线调包络、对齐网格，或者跑 Stem 分轨，把素材先准备干净。'
    },
    {
      step: '04',
      title: '导出并回写整理结果',
      description: '导出文件、移动歌单、回收误删内容，最后把结果落回真实文件系统。'
    }
  ],
  faqIntro: {
    kicker: 'FAQ',
    title: '该提前说明的事直接说',
    description: '隐私、联网、这些新模块的定位和 Pioneer 库支持，免得后面来回扯。'
  },
  faqs: [
    {
      q: '会上传音频吗？',
      a: '不会。云同步同步的是 SHA256 指纹，不上传音频本体和标签。'
    },
    {
      q: '必须联网吗？',
      a: '本地整理、播放、去重可以离线；在线补齐、云同步、检查更新这些能力才需要联网。'
    },
    {
      q: '最近新增了哪些模块？',
      a: 'Mixtape 自动录制、Stem 分轨运行时、Pioneer U 盘库、全局搜歌、独立转换和闲时分析调度。'
    },
    {
      q: 'OneLibrary 和旧 Device Library 都能看吗？',
      a: '支持，两条链路都已经接进来，也补了入口分组、歌单树和预览能力。'
    },
    {
      q: '运行时下载是干嘛的？',
      a: 'Stem 分轨需要额外运行时组件，现在按需下载，避免主安装包膨胀得没边。'
    },
    {
      q: '有 Linux 版本吗？',
      a: '暂无 Linux 正式版。'
    }
  ],
  specs: {
    title: '系统要求与格式覆盖',
    systems: ['Windows 10 或更高版本（x64）', 'macOS 12 或更高版本', '暂无 Linux 正式版'],
    formats:
      'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV',
    formatsNote: '扫描格式可在设置里配置，转换链路基于内建 FFmpeg 管线。'
  },
  footer: '为 DJ 与音频整理场景做的开源桌面工具'
}

const enContent = {
  nav: [
    { label: 'Core', href: '#features' },
    { label: 'New Features', href: '#new-features' },
    { label: 'Workflow', href: '#workflow' },
    { label: 'FAQ', href: '#faq' }
  ],
  hero: {
    kicker: 'Open-source desktop audio workflow',
    titleTop: 'Ergonomic',
    titleBottom: 'Fast Audio Organization Tool',
    description:
      'FRKB keeps the same keyboard-first organization workflow built around fingerprint dedup and true file mapping, while the newer Mixtape, stem, and Pioneer USB additions are explained below without turning the homepage into a bloated feature wall.',
    pills: ['Keyboard-first', 'Content fingerprint dedup', 'True file mapping'],
    notes: [
      'Windows and macOS are supported, and download buttons adapt to your current platform.',
      'The newer modules are documented below, while the homepage keeps the earlier, simpler visual style.'
    ],
    releasesLabel: 'Browse Releases'
  },
  featuresIntro: {
    kicker: 'Core Features',
    title: 'The original workflow remains the backbone',
    description:
      'Import, preview, dedup, organize, and export still sit at the center of the product.'
  },
  features: [
    {
      title: 'Keyboard-first speed',
      details: 'Frequent actions are mapped to shortcuts so screening tracks stays fast.'
    },
    {
      title: 'Fingerprint dedup',
      details:
        'Import dedup, playlist cleanup, and fingerprint-library workflows support both content fingerprints and file hashes.'
    },
    {
      title: 'True file mapping',
      details:
        'Filter and curated libraries stay aligned with real folders, so organization changes land on disk.'
    },
    {
      title: 'Waveforms and preview',
      details:
        'SoundCloud, detailed, and RGB waveform views plus list preview keep fast listening intact.'
    },
    {
      title: 'BPM / key analysis',
      details: 'Background BPM/key analysis stays editable with Tap Tempo correction.'
    },
    {
      title: 'Metadata and artwork',
      details:
        'Tag editing, cover replacement, and MusicBrainz / AcoustID assisted cleanup are all part of the flow.'
    }
  ],
  newFeaturesIntro: {
    kicker: 'What Is New',
    title: 'New modules are documented without changing the whole tone',
    description:
      'The older visual direction is back. Recent additions are listed in one place instead of being spread across an oversized landing page.'
  },
  newFeatures: [
    {
      title: 'Mixtape auto-recording',
      description:
        'A dedicated Mixtape workspace now keeps arrangement, preview, parameter tuning, and export inside one timeline-driven surface.',
      bullets: [
        'Dual-track timeline, beat-aligned waveforms, first-downbeat analysis',
        'Metronome, BPM draft saving, zoom, and follow-scroll',
        'Gain / BPM envelopes, mute sections, undo, and export consistency'
      ]
    },
    {
      title: 'Managed stem runtime',
      description:
        'Stem preparation is now treated as a full runtime workflow with caching, warm-up, and on-demand dependencies.',
      bullets: [
        'Demucs runtime management and caching',
        'ONNX fast separation plus DirectML / XPU acceleration',
        'Download only what is needed instead of bloating the main installer'
      ]
    },
    {
      title: 'Pioneer USB libraries',
      description:
        'FRKB can now work directly with Pioneer USB libraries instead of limiting the workflow to local folders only.',
      bullets: [
        'Supports both Device Library and OneLibrary paths',
        'Playlist tree, preview waveforms, read-only preview, and playback entry points',
        'Multi-drive detection, grouped entries, and eject handling'
      ]
    },
    {
      title: 'Search, conversion, and idle scheduling',
      description:
        'A few high-frequency gaps were filled so searching, converting, and background analysis feel less scattered.',
      bullets: [
        'Global track search with more reliable locate feedback',
        'Standalone format-conversion tool',
        'Unified idle scheduling and throttling for steadier background analysis'
      ]
    }
  ],
  workflowIntro: {
    kicker: 'Workflow',
    title: 'A four-step flow is still the default rhythm',
    description:
      'Import, decide, process, and land results back on disk without unnecessary detours.'
  },
  workflow: [
    {
      step: '01',
      title: 'Import local or device libraries',
      description:
        'Drag in local folders or connect Pioneer USB libraries to bring sources into one flow.'
    },
    {
      step: '02',
      title: 'Preview, search, analyze',
      description:
        'Use waveform previews, global search, BPM/key analysis, and shortcuts to make decisions quickly.'
    },
    {
      step: '03',
      title: 'Prepare recording or stems',
      description: 'Open the Mixtape timeline or run stem separation before moving on to output.'
    },
    {
      step: '04',
      title: 'Export and write changes back',
      description:
        'Export files, move playlists, recover mistakes, and keep everything aligned with the file system.'
    }
  ],
  faqIntro: {
    kicker: 'FAQ',
    title: 'The useful answers are stated plainly',
    description:
      'Privacy, connectivity, new modules, and Pioneer support are easier to explain directly.'
  },
  faqs: [
    {
      q: 'Does FRKB upload my audio?',
      a: 'No. Cloud Sync only syncs SHA256 fingerprints, not audio files or tags.'
    },
    {
      q: 'Do I need internet?',
      a: 'Local organization, playback, and dedup work offline. Metadata fill, cloud sync, and update checks need a connection.'
    },
    {
      q: 'Which modules were added recently?',
      a: 'Mixtape auto-recording, managed stem runtime, Pioneer USB libraries, global search, standalone conversion, and idle scheduling.'
    },
    {
      q: 'Can it read both OneLibrary and the older Device Library?',
      a: 'Yes. Both Pioneer paths are supported, including grouped entries, playlist browsing, and preview-oriented handling.'
    },
    {
      q: 'Why is runtime download mentioned here?',
      a: 'Stem separation needs extra runtime assets, so they are downloaded on demand instead of inflating the main installer.'
    },
    {
      q: 'Is there a Linux build?',
      a: 'No official Linux build yet.'
    }
  ],
  specs: {
    title: 'System requirements and format coverage',
    systems: ['Windows 10 or later (x64)', 'macOS 12 or later', 'No official Linux build yet'],
    formats:
      'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV',
    formatsNote:
      'Scanned formats can be configured in Settings, and conversion runs on the built-in FFmpeg pipeline.'
  },
  footer: 'An open-source desktop tool built for DJs and audio organization'
}

const pageContent = computed(() => (isEn.value ? enContent : zhContent))

onMounted(() => {
  const savedTheme = localStorage.getItem('theme') || 'dark'
  theme.value = savedTheme
  applyTheme(savedTheme)
  void initDownloadButtons()
  window.addEventListener('mousemove', handleMouseMove)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', handleMouseMove)
})
</script>

<template>
  <div class="custom-home">
    <div ref="glowRef" class="mouse-glow"></div>

    <nav class="site-nav">
      <div class="container nav-inner">
        <a class="brand" :href="withBase(isEn ? '/en/' : '/')">
          <img :src="withBase('/assets/icon.webp')" alt="FRKB" />
          <span>FRKB</span>
        </a>

        <div class="nav-links">
          <a v-for="item in pageContent.nav" :key="item.href" :href="item.href">{{ item.label }}</a>
          <a
            href="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>

        <div class="nav-actions">
          <button
            class="theme-toggle"
            :aria-label="isEn ? 'Toggle theme' : '切换主题'"
            @click="toggleTheme"
          >
            <span v-if="theme === 'dark'">☀</span>
            <span v-else>☾</span>
          </button>
          <a :href="withBase(isEn ? '/' : '/en/')" class="lang-toggle">
            {{ isEn ? '中文' : 'EN' }}
          </a>
        </div>
      </div>
    </nav>

    <header class="hero">
      <div class="container hero-inner">
        <p class="hero-kicker">{{ pageContent.hero.kicker }}</p>
        <h1 class="hero-title">
          <span>{{ pageContent.hero.titleTop }}</span>
          <span class="accent">{{ pageContent.hero.titleBottom }}</span>
        </h1>
        <p class="hero-description">{{ pageContent.hero.description }}</p>

        <div class="hero-pills">
          <span v-for="pill in pageContent.hero.pills" :key="pill" class="pill">{{ pill }}</span>
        </div>

        <div class="cta">
          <div v-if="isLoadingDownloads" class="cta-skeleton">
            <div class="skeleton-pill"></div>
          </div>

          <div v-else class="cta-group">
            <a
              v-if="showWin"
              class="download-btn"
              :href="winUrl"
              target="_blank"
              rel="nofollow noopener noreferrer"
            >
              <span class="download-os">Windows</span>
              <strong>{{
                isEn
                  ? version
                    ? `Download ${version}`
                    : 'Download'
                  : version
                    ? `下载 ${version}`
                    : '下载'
              }}</strong>
            </a>

            <a
              v-if="showMac"
              class="download-btn secondary"
              :href="macUrl"
              target="_blank"
              rel="nofollow noopener noreferrer"
            >
              <span class="download-os">macOS</span>
              <strong>{{
                isEn
                  ? version
                    ? `Download ${version}`
                    : 'Download'
                  : version
                    ? `下载 ${version}`
                    : '下载'
              }}</strong>
            </a>
          </div>

          <div class="hero-links">
            <a
              class="subtle-link"
              href="https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases"
              target="_blank"
              rel="noreferrer"
            >
              {{ pageContent.hero.releasesLabel }}
            </a>
            <a v-if="!isLoadingDownloads" href="#" class="subtle-link" @click="togglePlatform">
              {{ isEn ? 'Switch platform' : '切换平台' }}
            </a>
          </div>

          <div class="hero-notes">
            <p v-for="note in pageContent.hero.notes" :key="note" class="hero-note">{{ note }}</p>
          </div>
        </div>

        <div class="hero-frame">
          <img
            class="hero-image"
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
    </header>

    <main>
      <section id="features" class="section">
        <div class="container">
          <div class="section-header">
            <p class="section-kicker">{{ pageContent.featuresIntro.kicker }}</p>
            <h2>{{ pageContent.featuresIntro.title }}</h2>
            <p>{{ pageContent.featuresIntro.description }}</p>
          </div>

          <div class="card-grid">
            <article
              v-for="item in pageContent.features"
              :key="item.title"
              class="card feature-card"
            >
              <h3>{{ item.title }}</h3>
              <p>{{ item.details }}</p>
            </article>
          </div>
        </div>
      </section>

      <section id="new-features" class="section section-tinted">
        <div class="container">
          <div class="section-header">
            <p class="section-kicker">{{ pageContent.newFeaturesIntro.kicker }}</p>
            <h2>{{ pageContent.newFeaturesIntro.title }}</h2>
            <p>{{ pageContent.newFeaturesIntro.description }}</p>
          </div>

          <div class="new-feature-grid">
            <article
              v-for="item in pageContent.newFeatures"
              :key="item.title"
              class="card new-feature-card"
            >
              <h3>{{ item.title }}</h3>
              <p>{{ item.description }}</p>
              <ul class="bullet-list">
                <li v-for="bullet in item.bullets" :key="bullet">{{ bullet }}</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section id="workflow" class="section">
        <div class="container">
          <div class="section-header">
            <p class="section-kicker">{{ pageContent.workflowIntro.kicker }}</p>
            <h2>{{ pageContent.workflowIntro.title }}</h2>
            <p>{{ pageContent.workflowIntro.description }}</p>
          </div>

          <div class="workflow-grid">
            <article
              v-for="item in pageContent.workflow"
              :key="item.step"
              class="card workflow-card"
            >
              <span class="workflow-step">{{ item.step }}</span>
              <h3>{{ item.title }}</h3>
              <p>{{ item.description }}</p>
            </article>
          </div>
        </div>
      </section>

      <section id="faq" class="section faq-section">
        <div class="container info-grid">
          <div class="card specs-card">
            <p class="section-kicker">{{ isEn ? 'Platforms & Formats' : '环境与格式' }}</p>
            <h2>{{ pageContent.specs.title }}</h2>
            <ul class="bullet-list compact">
              <li v-for="item in pageContent.specs.systems" :key="item">{{ item }}</li>
            </ul>
            <div class="formats-panel">
              <h3>{{ isEn ? 'Formats' : '格式' }}</h3>
              <p>{{ pageContent.specs.formats }}</p>
              <p class="muted">{{ pageContent.specs.formatsNote }}</p>
            </div>
          </div>

          <div>
            <div class="section-header left">
              <p class="section-kicker">{{ pageContent.faqIntro.kicker }}</p>
              <h2>{{ pageContent.faqIntro.title }}</h2>
              <p>{{ pageContent.faqIntro.description }}</p>
            </div>

            <div class="faq-grid">
              <article v-for="item in pageContent.faqs" :key="item.q" class="card faq-card">
                <h3>{{ item.q }}</h3>
                <p>{{ item.a }}</p>
              </article>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div class="container footer-inner">
        <p>{{ pageContent.footer }}</p>
        <small>© {{ currentYear }} FRKB Project</small>
      </div>
    </footer>
  </div>
</template>

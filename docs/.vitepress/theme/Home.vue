<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useData, withBase } from 'vitepress'

const { localeIndex } = useData()
const isEn = computed(() => String(localeIndex.value || '') === 'en')

const theme = ref('dark')
const glowRef = ref(null)

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
const currentYear = new Date().getFullYear()

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
    { label: 'Beta 功能', href: '#highlights' },
    { label: '核心能力', href: '#core' },
    { label: '工作流', href: '#workflow' },
    { label: 'FAQ', href: '#faq' }
  ],
  hero: {
    eyebrow: '开源桌面音频工作流',
    titleLines: ['把音频整理、', '自动混音 Beta 与 Pioneer U 盘', '塞进一个工具里'],
    description:
      'FRKB 面向 DJ 与音频整理场景，把快速筛歌、指纹去重、波形试听，以及 Mixtape 自动混音、Stem 分轨、Pioneer U 盘库浏览、全局搜歌这些 Beta 模块整合到同一个桌面应用里。',
    pills: ['键盘优先', '内容指纹去重', '真实文件映射'],
    stableNote: '支持 Windows 与 macOS，下载按钮会自动优先匹配当前平台。',
    progressNote: '以下新模块当前按 Beta 标注，后续还会继续打磨交互和稳定性。',
    releasesLabel: '查看 Releases',
    releasesHref: 'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases'
  },
  releasePanel: {
    kicker: '产品概览',
    title: '从整理到混音准备，一条链做完',
    description:
      'FRKB 不只管文件整理，也把自动混音准备、Stem 分轨和 Pioneer 设备库这些仍在 Beta 的高频工作收到了同一个界面里。',
    bullets: [
      'Mixtape 自动混音时间线 Beta',
      'Stem 分轨运行时与加速 Beta',
      'Pioneer Device Library / OneLibrary Beta'
    ]
  },
  snapshotTags: ['Mixtape Beta', 'Stem Beta', 'Pioneer USB Beta', '全局搜歌 Beta'],
  updatesIntro: {
    eyebrow: 'Beta 功能',
    title: '这些新模块当前按 Beta 提供',
    description:
      '从自动混音准备、设备库浏览到分轨和转换，这些新模块已经可用，但当前仍按 Beta 口径持续迭代。'
  },
  updates: [
    {
      kicker: 'Mixtape Beta',
      title: '自动混音工作台（Beta）',
      description:
        '独立自动混音窗口和双轨时间线，先把“排混音、听效果、改参数、再导出”这套动作收进一个界面，当前仍在继续打磨。',
      bullets: [
        '节拍对齐波形、首拍分析、四拍步进',
        '节拍器、BPM 草稿保存、时间线缩放与跟随',
        '增益/BPM 包络、段落静音、撤销与导出一致'
      ]
    },
    {
      kicker: 'Stem Beta',
      title: '分轨运行时体系（Beta）',
      description:
        '把运行时管理、缓存、预热和多后端加速收拢起来，给混音准备素材省很多事，但当前仍按 Beta 模块维护。',
      bullets: [
        'Demucs 运行时管理与缓存',
        'ONNX fast 分离 + DirectML 调度',
        'XPU 分离、双 XPU worker、按需下载'
      ]
    },
    {
      kicker: 'Pioneer Beta',
      title: 'U 盘库支持（Beta）',
      description:
        '直接处理更多真实设备场景，不只盯着本地库，还能把 Pioneer 设备库工作流一起接进来，当前按 Beta 持续完善。',
      bullets: [
        '旧 Device Library 歌单与预览波形',
        'U 盘库播放、受限操作、只读列表波形预听',
        '多盘识别、弹出链路与 OneLibrary 入口分组'
      ]
    },
    {
      kicker: 'Search & Convert Beta',
      title: '全局搜歌与独立转换（Beta）',
      description:
        '把两个日常高频入口补齐，让找歌和转格式不用在一堆面板里绕圈，当前也仍按 Beta 提供。',
      bullets: ['全局搜歌入口', '更稳定的定位反馈', '独立格式转换工具']
    },
    {
      kicker: 'Background Beta',
      title: '闲时分析调度（Beta）',
      description:
        '统一闲时任务调度与限流，让后台分析别一股脑乱冲，尽量少去抢前台交互的资源，目前也按 Beta 标注。',
      bullets: ['统一闲时任务调度', '空闲限流', '后台分析完成率与稳定性提升']
    }
  ],
  coreIntro: {
    eyebrow: '核心能力',
    title: '基础能力继续顶着，高频能力也补齐了',
    description:
      '去重、试听、文件映射、标签维护这些老本行还在，而且现在和自动混音、分轨、设备库浏览这些能力被收到了更完整的一套流程里。'
  },
  core: [
    {
      title: '指纹去重',
      description: '内容指纹 / 文件哈希双模式，导入去重、歌单去重和指纹库同步一条链。'
    },
    {
      title: '真实文件映射',
      description: '界面里的筛选库、精选库和磁盘目录保持同步，整理结果不是假把式。'
    },
    {
      title: '波形与试听',
      description: 'SoundCloud、细节波形、RGB 能量波形，再加列表预览和区间播放，扫歌很快。'
    },
    {
      title: 'BPM / 调性分析',
      description: '后台分析 + Tap Tempo 校正，Classic 和 Camelot 两套展示都能切。'
    },
    {
      title: '元数据与封面',
      description: 'MusicBrainz / AcoustID 接入、批量补齐、封面替换和另存都已经打通。'
    },
    {
      title: '回收与导出',
      description: '回收站恢复、导出到文件夹、导出后删除等动作都围着真实文件在转。'
    }
  ],
  workflowIntro: {
    eyebrow: '工作流',
    title: '现在的 FRKB 更像一条完整音频处理链',
    description: '从导入、分析、搜歌到混音准备和导出，入口更集中，操作更顺手。'
  },
  workflow: [
    {
      step: '01',
      title: '导入本地库或设备库',
      description: '拖拽导入本地文件夹，或者接入 Pioneer U 盘库，把素材先拉进工作流。'
    },
    {
      step: '02',
      title: '搜歌、试听、分析',
      description: '用全局搜歌、波形预览、BPM / 调性分析和快捷键，快速做筛选判断。'
    },
    {
      step: '03',
      title: '做混音准备',
      description: '进 Mixtape 时间线调包络、对齐网格，或者跑 Stem 分轨，把素材先准备干净。'
    },
    {
      step: '04',
      title: '导出或回写整理结果',
      description: '导出文件、移动歌单、回收误删内容，最后把结果稳稳落回真实文件系统。'
    }
  ],
  specs: {
    eyebrow: '环境与格式',
    title: '系统要求与格式覆盖',
    systems: ['Windows 10 或更高版本（x64）', 'macOS 12 或更高版本', '暂无 Linux 正式版'],
    formats:
      'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV',
    formatsNote: '扫描格式可在设置里配置，转换链路基于内建 FFmpeg 管线。'
  },
  faqIntro: {
    eyebrow: 'FAQ',
    title: '有些事先说明白，省得后面扯皮',
    description:
      '同步范围、联网要求、这些 Beta 模块的定位，以及 Pioneer 库支持和运行时下载这些问题，这里直接说人话。'
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
      q: '这软件主要适合什么场景？',
      a: '适合 DJ、电子音乐整理、样本管理和需要频繁筛歌、做混音准备的人用。'
    },
    {
      q: '哪些功能现在按 Beta 提供？',
      a: 'Mixtape 自动混音、Stem 分轨、Pioneer U 盘库、全局搜歌、独立转换和闲时调度目前都按 Beta 标注。'
    },
    {
      q: 'OneLibrary 和旧 Device Library 都能看吗？',
      a: '支持，但当前属于 Pioneer U 盘库 Beta 能力的一部分，这两条链路都已经接进来，并补了入口分组和预览能力。'
    },
    {
      q: '有 Linux 版本吗？',
      a: '暂无 Linux 正式版。'
    },
    {
      q: '运行时下载是干嘛的？',
      a: 'Stem 分轨这类功能需要额外运行时，现在按需下载，避免主安装包无限膨胀。'
    }
  ],
  footer: '为 DJ 与音频整理场景做的开源桌面工具'
}

const enContent = {
  nav: [
    { label: 'Beta Features', href: '#highlights' },
    { label: 'Core', href: '#core' },
    { label: 'Workflow', href: '#workflow' },
    { label: 'FAQ', href: '#faq' }
  ],
  hero: {
    eyebrow: 'Open-source desktop audio workflow',
    titleLines: ['Bring audio organization,', 'auto-mixing beta and Pioneer USB', 'into one tool'],
    description:
      'FRKB is built for DJs and audio-heavy workflows. It combines fast screening, fingerprint deduplication, waveform-driven preview, plus beta modules for Mixtape auto-mix preparation, stem separation, Pioneer USB library browsing, and global search in one desktop app.',
    pills: ['Keyboard-first', 'Content fingerprint dedup', 'True file mapping'],
    stableNote:
      'Windows and macOS are supported, and download buttons adapt to your current platform.',
    progressNote:
      'The modules below are currently marked as beta while their workflows and stability continue to evolve.',
    releasesLabel: 'Browse Releases',
    releasesHref: 'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool/releases'
  },
  releasePanel: {
    kicker: 'Product Scope',
    title: 'From organization to mix prep in one chain',
    description:
      'FRKB does more than organize files. It also pulls beta workflows for auto-mix prep, stem separation, and Pioneer device libraries into the same workspace.',
    bullets: [
      'Mixtape auto-mix timeline beta',
      'Stem runtime + acceleration beta',
      'Pioneer Device Library / OneLibrary beta'
    ]
  },
  snapshotTags: ['Mixtape beta', 'Stem beta', 'Pioneer USB beta', 'Global search beta'],
  updatesIntro: {
    eyebrow: 'Beta Features',
    title: 'These newer modules are currently in beta',
    description:
      'Auto-mix prep, device-library browsing, stem work, search, conversion, and idle scheduling are already usable here, but they are still presented as beta features.'
  },
  updates: [
    {
      kicker: 'Mixtape Beta',
      title: 'Auto-mix workspace (Beta)',
      description:
        'A dedicated auto-mix window and dual-track timeline keep arranging, previewing, tweaking, and exporting inside one workspace, and the workflow is still being refined.',
      bullets: [
        'Beat-grid waveform view, first-downbeat analysis, four-beat stepping',
        'Metronome, BPM draft saving, timeline zoom and follow-scroll',
        'Gain/BPM envelopes, mute segments, undo, and timeline-accurate export'
      ]
    },
    {
      kicker: 'Stem Beta',
      title: 'Managed separation runtime (Beta)',
      description:
        'Stem prep is handled by a managed runtime stack with caching, warm-up, and accelerated backends for mix preparation, and it is still treated as a beta module.',
      bullets: [
        'Demucs runtime management and caching',
        'ONNX fast separation + DirectML scheduling',
        'XPU separation, dual XPU workers, on-demand downloads'
      ]
    },
    {
      kicker: 'Pioneer Beta',
      title: 'USB library support (Beta)',
      description:
        'The app can deal with real Pioneer USB workflows instead of only local libraries, and this capability is still labeled beta.',
      bullets: [
        'Legacy Device Library playlists and preview waveforms',
        'USB playback, guarded operations, and waveform preview on read-only lists',
        'Multi-drive recognition, eject handling, and OneLibrary grouping'
      ]
    },
    {
      kicker: 'Search & Convert Beta',
      title: 'Global search and standalone conversion (Beta)',
      description:
        'Two high-frequency entry points help users find tracks faster and run batch conversion without bouncing through unrelated views, and both are currently beta.',
      bullets: [
        'Global track search',
        'More reliable locate feedback',
        'Standalone format conversion tool'
      ]
    },
    {
      kicker: 'Background Beta',
      title: 'Idle analysis scheduling (Beta)',
      description:
        'Background jobs are coordinated through a unified idle scheduler with throttling so they stop fighting the foreground quite as much, and the scheduler is still marked beta.',
      bullets: [
        'Unified idle-task scheduling',
        'Idle throttling',
        'Better background analysis completion and stability'
      ]
    }
  ],
  coreIntro: {
    eyebrow: 'Core Capabilities',
    title: 'The fundamentals still carry the workflow',
    description:
      'Dedup, preview, file mapping, metadata cleanup, and export still matter, and they now sit alongside mix prep, stem work, and device-library browsing in one flow.'
  },
  core: [
    {
      title: 'Fingerprint dedup',
      description:
        'Content-fingerprint and file-hash modes cover import dedup, playlist cleanup, and fingerprint database workflows.'
    },
    {
      title: 'True file mapping',
      description:
        'Filter and curated libraries stay aligned with real folders, so organization results are not just virtual references.'
    },
    {
      title: 'Waveforms and preview',
      description:
        'SoundCloud, detailed, and RGB energy views combine with list previews and playback range control for rapid screening.'
    },
    {
      title: 'BPM / key analysis',
      description:
        'Background analysis plus Tap Tempo correction keep BPM and key data editable instead of frozen.'
    },
    {
      title: 'Metadata and artwork',
      description:
        'MusicBrainz and AcoustID integration support metadata cleanup, batch fill, cover replacement, and local artwork saving.'
    },
    {
      title: 'Recycle and export',
      description:
        'Recycle Bin restore, folder export, and delete-after-export all stay tied to the real file system.'
    }
  ],
  workflowIntro: {
    eyebrow: 'Workflow',
    title: 'FRKB behaves more like a full audio-processing chain',
    description:
      'Import, analyze, search, prepare stems, shape a mix, and export without bouncing across five different apps unless you really want to.'
  },
  workflow: [
    {
      step: '01',
      title: 'Import local or device libraries',
      description:
        'Drag in local folders or connect Pioneer USB libraries to pull sources into one flow.'
    },
    {
      step: '02',
      title: 'Search, preview, analyze',
      description:
        'Use global search, waveform previews, BPM/key analysis, and shortcuts to make decisions quickly.'
    },
    {
      step: '03',
      title: 'Prepare the mix',
      description:
        'Open the Mixtape timeline to shape envelopes and grids, or run stem separation before mixing.'
    },
    {
      step: '04',
      title: 'Export and write changes back',
      description:
        'Export files, move playlists, or recover mistakes, then land everything back on the real file system.'
    }
  ],
  specs: {
    eyebrow: 'Platforms & Formats',
    title: 'System requirements and format coverage',
    systems: ['Windows 10 or later (x64)', 'macOS 12 or later', 'No official Linux build yet'],
    formats:
      'MP3, WAV, FLAC, AIF, AIFF, OGG, OPUS, AAC, M4A, MP4, WMA, AC3, DTS, MKA, WEBM, APE, TAK, TTA, WV',
    formatsNote:
      'Scanned formats can be configured in Settings. Conversion runs on the built-in FFmpeg pipeline.'
  },
  faqIntro: {
    eyebrow: 'FAQ',
    title: 'A few things are better stated plainly',
    description:
      'Privacy, connectivity, which modules are beta, Pioneer library support, and runtime downloads are all easier to explain directly than to bury in scattered notes.'
  },
  faqs: [
    {
      q: 'Does FRKB upload my audio?',
      a: 'No. Cloud Sync only syncs SHA256 fingerprints, not the audio files or their tags.'
    },
    {
      q: 'Do I need internet?',
      a: 'Local organization, playback, and dedup work offline. Metadata fill, cloud sync, and update checks need a connection.'
    },
    {
      q: 'Who is this built for?',
      a: 'DJs, electronic music collectors, sample-heavy libraries, and anyone who spends real time screening tracks and preparing mixes.'
    },
    {
      q: 'Which features are currently beta?',
      a: 'Mixtape auto-mix, stem separation, Pioneer USB libraries, global search, standalone conversion, and idle scheduling are currently labeled as beta.'
    },
    {
      q: 'Can it read both OneLibrary and the older Device Library?',
      a: 'Yes. Both Pioneer USB library paths are supported, including grouped entries and preview-oriented handling, and they currently sit inside the Pioneer beta workflow.'
    },
    {
      q: 'Is there a Linux build?',
      a: 'No official Linux build yet.'
    },
    {
      q: 'Why is runtime download mentioned here?',
      a: 'Stem separation needs extra runtime assets, so they are downloaded on demand instead of bloating the main installer.'
    }
  ],
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
    <div class="ambient ambient-a"></div>
    <div class="ambient ambient-b"></div>

    <nav class="site-nav">
      <div class="shell nav-shell">
        <a class="brand" :href="withBase('/')">
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

    <main>
      <section class="hero-section">
        <div class="shell hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">{{ pageContent.hero.eyebrow }}</p>
            <h1 class="hero-title">
              <span>{{ pageContent.hero.titleLines[0] }}</span>
              <span class="accent">{{ pageContent.hero.titleLines[1] }}</span>
              <span>{{ pageContent.hero.titleLines[2] }}</span>
            </h1>
            <p class="hero-description">
              {{ pageContent.hero.description }}
            </p>

            <div class="pill-row">
              <span v-for="pill in pageContent.hero.pills" :key="pill" class="pill">{{
                pill
              }}</span>
            </div>

            <div class="cta-block">
              <div v-if="isLoadingDownloads" class="download-skeleton"></div>
              <div v-else class="download-group">
                <a
                  v-if="showWin"
                  class="download-btn primary"
                  :href="winUrl"
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                >
                  <span class="download-platform">Windows</span>
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
                  <span class="download-platform">macOS</span>
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

              <div class="cta-row">
                <a
                  class="ghost-btn"
                  :href="pageContent.hero.releasesHref"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ pageContent.hero.releasesLabel }}
                </a>

                <a v-if="!isLoadingDownloads" href="#" class="switch-link" @click="togglePlatform">
                  {{ isEn ? 'Switch platform' : '切换平台' }}
                </a>
              </div>

              <p class="hero-note">{{ pageContent.hero.stableNote }}</p>
              <p class="hero-note">{{ pageContent.hero.progressNote }}</p>
            </div>
          </div>

          <div class="hero-side">
            <div class="release-panel card-surface">
              <p class="panel-kicker">{{ pageContent.releasePanel.kicker }}</p>
              <h2>{{ pageContent.releasePanel.title }}</h2>
              <p>{{ pageContent.releasePanel.description }}</p>
              <ul class="bullet-list compact">
                <li v-for="item in pageContent.releasePanel.bullets" :key="item">{{ item }}</li>
              </ul>
            </div>

            <div class="snapshot card-surface">
              <img
                class="snapshot-image"
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
              <div class="snapshot-tags">
                <span v-for="tag in pageContent.snapshotTags" :key="tag">{{ tag }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="highlights" class="section-block">
        <div class="shell">
          <div class="section-head">
            <p class="eyebrow">{{ pageContent.updatesIntro.eyebrow }}</p>
            <h2>{{ pageContent.updatesIntro.title }}</h2>
            <p>{{ pageContent.updatesIntro.description }}</p>
          </div>

          <div class="update-grid">
            <article
              v-for="item in pageContent.updates"
              :key="item.title"
              class="update-card card-surface"
            >
              <p class="card-kicker">{{ item.kicker }}</p>
              <h3>{{ item.title }}</h3>
              <p class="card-description">{{ item.description }}</p>
              <ul class="bullet-list">
                <li v-for="bullet in item.bullets" :key="bullet">{{ bullet }}</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section id="core" class="section-block core-block">
        <div class="shell">
          <div class="section-head">
            <p class="eyebrow">{{ pageContent.coreIntro.eyebrow }}</p>
            <h2>{{ pageContent.coreIntro.title }}</h2>
            <p>{{ pageContent.coreIntro.description }}</p>
          </div>

          <div class="core-grid">
            <article
              v-for="item in pageContent.core"
              :key="item.title"
              class="core-card card-surface"
            >
              <h3>{{ item.title }}</h3>
              <p>{{ item.description }}</p>
            </article>
          </div>
        </div>
      </section>

      <section id="workflow" class="section-block">
        <div class="shell">
          <div class="section-head">
            <p class="eyebrow">{{ pageContent.workflowIntro.eyebrow }}</p>
            <h2>{{ pageContent.workflowIntro.title }}</h2>
            <p>{{ pageContent.workflowIntro.description }}</p>
          </div>

          <div class="workflow-grid">
            <article
              v-for="item in pageContent.workflow"
              :key="item.step"
              class="workflow-card card-surface"
            >
              <span class="workflow-step">{{ item.step }}</span>
              <h3>{{ item.title }}</h3>
              <p>{{ item.description }}</p>
            </article>
          </div>
        </div>
      </section>

      <section id="faq" class="section-block faq-block">
        <div class="shell faq-layout">
          <div class="specs-card card-surface">
            <p class="eyebrow">{{ pageContent.specs.eyebrow }}</p>
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
            <div class="section-head left">
              <p class="eyebrow">{{ pageContent.faqIntro.eyebrow }}</p>
              <h2>{{ pageContent.faqIntro.title }}</h2>
              <p>{{ pageContent.faqIntro.description }}</p>
            </div>

            <div class="faq-grid">
              <article v-for="item in pageContent.faqs" :key="item.q" class="faq-card card-surface">
                <h3>{{ item.q }}</h3>
                <p>{{ item.a }}</p>
              </article>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <div class="shell footer-shell">
        <p>{{ pageContent.footer }}</p>
        <small>© {{ currentYear }} FRKB Project</small>
      </div>
    </footer>
  </div>
</template>

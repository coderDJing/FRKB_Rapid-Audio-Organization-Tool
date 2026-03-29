import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'FRKB',
  description: 'Rapid Audio Organization Tool',
  base: '/FRKB_Rapid-Audio-Organization-Tool/',
  lastUpdated: true,
  cleanUrls: true,

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'FRKB - 开源音频快速整理工具',
      description:
        '内容感知去重、波形试听、Mixtape 自动录制、Stem 分轨与 Pioneer U 盘库整合在同一套音频工作流里。'
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'FRKB - Fast Audio Organization Tool',
      description:
        'Content-aware dedup, waveform preview, Mixtape auto-recording, stem separation, and Pioneer USB libraries in one desktop workflow.'
    }
  },

  themeConfig: {
    logo: '/assets/icon.webp',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool' }
    ]
  },

  head: [
    ['link', { rel: 'icon', href: '/FRKB_Rapid-Audio-Organization-Tool/assets/icon.webp' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap',
        rel: 'stylesheet'
      }
    ]
  ]
})

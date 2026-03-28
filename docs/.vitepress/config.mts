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
      description: '自动混音、Stem 分轨、Pioneer U 盘库与指纹去重整合在一套音频工作流里。'
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'FRKB - Fast Audio Organization Tool',
      description:
        'A keyboard-first audio workflow with auto-mixing, stem prep, Pioneer USB libraries, and fingerprint dedup.'
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
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap',
        rel: 'stylesheet'
      }
    ]
  ]
})

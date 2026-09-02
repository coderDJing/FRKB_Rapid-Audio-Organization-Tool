import { defineConfig } from 'vitepress'

const jsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Track Studio',
  alternateName: ['FRKB', 'FRKB Rapid Audio Organization Tool'],
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Windows, macOS',
  url: 'https://coderdjing.github.io/Track-Studio/',
  downloadUrl: 'https://github.com/coderDJing/Track-Studio/releases/latest',
  description:
    'Track Studio (formerly FRKB) is a desktop audio workflow tool for DJs: real file organization, SET playlists, fingerprint dedup, waveform preview, Rekordbox libraries, and Mixtape.'
})

export default defineConfig({
  title: 'Track Studio',
  description: 'Track Studio (formerly FRKB) — Rapid Audio Organization Tool',
  base: '/Track-Studio/',
  lastUpdated: true,
  cleanUrls: true,

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Track Studio - 开源音频快速整理工具',
      description:
        '内容感知去重、波形试听、Mixtape 自动录制、Stem 分轨与 Rekordbox U 盘库整合在同一套音频工作流里。'
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Track Studio - Fast Audio Organization Tool',
      description:
        'Content-aware dedup, waveform preview, Mixtape auto-recording, stem separation, and Rekordbox USB libraries in one desktop workflow.'
    }
  },

  themeConfig: {
    logo: '/assets/icon.webp',
    socialLinks: [{ icon: 'github', link: 'https://github.com/coderDJing/Track-Studio' }]
  },

  head: [
    ['link', { rel: 'icon', href: '/Track-Studio/assets/icon.webp' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap',
        rel: 'stylesheet'
      }
    ],
    ['script', { type: 'application/ld+json' }, jsonLd]
  ]
})

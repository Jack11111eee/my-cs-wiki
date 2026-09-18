import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'my-cs-wiki',
  description: '我的计算机经验总结',
  base: '/my-cs-wiki/',

  themeConfig: {
    nav: [
      { text: '科研', link: '/research' },
      { text: '项目', link: '/project' },
      { text: '与 AI 协作', link: '/ai-collab' },
    ],

    sidebar: [
      {
        text: '目录',
        items: [
          { text: '科研', link: '/research' },
          { text: '项目', link: '/project' },
          { text: '与 AI 协作', link: '/ai-collab' },
        ],
      },
    ],

    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
  },
})
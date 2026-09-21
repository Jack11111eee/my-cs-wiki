import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'my-cs-wiki',
  description: '我的计算机经验总结',
  base: '/my-cs-wiki/',

  themeConfig: {
    nav: [
      {
        text: '心得',
        items: [
          { text: '科研', link: '/insights/research' },
          { text: '项目', link: '/insights/project' },
          { text: '与 AI 协作', link: '/insights/ai-collab' },
        ],
      },
      { text: '动态', link: '/activity' },
    ],

    sidebar: [
      {
        text: '心得',
        collapsed: false,
        items: [
          { text: '科研', link: '/insights/research' },
          { text: '项目', link: '/insights/project' },
          { text: '与 AI 协作', link: '/insights/ai-collab' },
        ],
      },
      {
        text: '动态',
        items: [{ text: '贡献图表', link: '/activity' }],
      },
    ],

    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
  },
})
import { defineConfig } from 'vitepress'

// 心得页的内容存在 frontmatter 的 notes 列表里（便于 Sveltia CMS 逐条编辑）。
// 这里在构建时把它还原成正文的「标题 + 有序列表」，渲染结果与原稿一致。
function insightsNotesPlugin(md: any) {
  md.core.ruler.push('insights-notes', (state: any) => {
    const { title, notes } = state.env?.frontmatter ?? {}
    if (!Array.isArray(notes) || state.env?.__insightsRendered) return

    const head = title ? `# ${title}\n\n` : ''
    const list = notes
      .map((note: string) => `1. ${String(note).replace(/\n/g, '\n   ')}`)
      .join('\n')

    state.tokens = md.parse(head + list, { ...state.env, __insightsRendered: true })
  })
}

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

  markdown: {
    config: (md) => {
      md.use(insightsNotesPlugin)
    },
  },
})
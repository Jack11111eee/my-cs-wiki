# my-cs-wiki

比特碎金笺。

在线阅读：https://jack11111eee.github.io/my-cs-wiki/

## 目录

### 心得

- [科研](docs/insights/research.md) —— 数据获取与下载、科研流程
- [项目](docs/insights/project.md) —— 项目构建流程、框架选型
- [与 AI 协作](docs/insights/ai-collab.md) —— 与智能体沟通、任务编排

### 动态

- [贡献图表](docs/activity.md) —— GitHub contribution 的四种画法

## 维护

贡献图的数据内联在 `docs/.vitepress/theme/contrib-data.js`，由 `scripts/fetch-contrib.mjs` 生成。窗口是滚动的「最近一年」，隔一段时间重跑该脚本，数字会变：

```bash
node scripts/fetch-contrib.mjs
```
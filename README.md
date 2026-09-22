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

贡献图的数据在 `docs/.vitepress/theme/contrib-data.js`，由 `scripts/fetch-contrib.mjs` 生成。窗口是滚动的「最近一年」，所以天数会在 366–371 之间浮动，数字也会变。

**自动更新**：`.github/workflows/deploy.yml` 每天 UTC 03:17 重建一次站点，构建前先跑取数脚本，数据只进产物、不提交回仓库。脚本有三条降级：

```
① GraphQL（api.github.com）      —— 权威源，图上数字以它为准
      ↓ 失败
② HTML 抓取（零鉴权）            —— 只在仓库快照超过 3 天时才启用
      ↓ 失败
③ 保留仓库里的快照，照常部署
```

②的数字与①有 1–3 的漂移（归日口径不同，不是漏算），所以只在数据已经很旧时才用它。页面底部会标明本次用的是哪条路径。

**手动更新**：

```bash
node scripts/fetch-contrib.mjs   # 本地用 gh 的登录态，或设 GH_TOKEN
git commit -am "update contrib data" && git push
```

**如果自动更新停了**：仓库连续 60 天无活动，GitHub 会停用定时任务（会发邮件）。到仓库的 Actions 页面手动跑一次 `Deploy VitePress site to Pages`（`Run workflow`）即可恢复。

**如果 GraphQL 一直失败**：说明 Actions 自带的 `GITHUB_TOKEN` 查不了 `contributionsCollection`。建一个 classic PAT（勾 `read:user`）存成仓库 secret `CONTRIB_TOKEN` 即可，workflow 会自动优先用它。
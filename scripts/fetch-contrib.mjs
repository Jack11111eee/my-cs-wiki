#!/usr/bin/env node
/* ============================================================================
   重新生成 docs/.vitepress/theme/contrib-data.js

   数据源：GitHub GraphQL contributionsCollection.contributionCalendar
   窗口是滚动的「最近一年」，所以隔一段时间重跑，区间和数字都会变。

   依赖 gh CLI 且已登录（gh auth status 能过）。用法：
     node scripts/fetch-contrib.mjs
   跑完 git diff 看一眼，然后连同贡献图一起提交。

   只写一份 366 天的原始数组，四张图的窗口和分层都由 ContribCharts.vue
   自己推（slice(-90) / slice(-60) / 分层计数），不在这里预先切好。
   ============================================================================ */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LOGIN = 'Jack11111eee'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', '.vitepress', 'theme', 'contrib-data.js')

const QUERY = `query { user(login: "${LOGIN}") {
  contributionsCollection { contributionCalendar {
    totalContributions
    weeks { contributionDays { date contributionCount } }
  } } } }`

const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], { encoding: 'utf8' })
const cal = JSON.parse(raw).data.user.contributionsCollection.contributionCalendar

const days = cal.weeks.flatMap((w) => w.contributionDays)
const start = days[0].date
const fetchedAt = new Date().toISOString().slice(0, 10)

const file = `/* 由 scripts/fetch-contrib.mjs 生成，不要手改。
   数据源：GitHub GraphQL contributionsCollection.contributionCalendar
   账号：${LOGIN} · 窗口：滚动一年 · 抓取于 ${fetchedAt}

   days 是连续 ${days.length} 天的每日贡献数，从 ${start} 起。
   四张图共用这一份：条形码取 slice(-90)、面积图取 slice(-60)、
   漏斗按阈值分层，窗口起点都在 ContribCharts.vue 里推。 */
export const CONTRIB = {
  login: '${LOGIN}',
  start: '${start}',
  fetchedAt: '${fetchedAt}',
  total: ${cal.totalContributions},
  days: [${days.map((d) => d.contributionCount).join(', ')}],
}
`

writeFileSync(OUT, file)
console.log(`写入 ${OUT}`)
console.log(`${days.length} 天 · 合计 ${cal.totalContributions} · ${start} 起`)
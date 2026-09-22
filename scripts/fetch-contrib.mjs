#!/usr/bin/env node
/* ============================================================================
   重新生成 docs/.vitepress/theme/contrib-data.js

   三级降级：
     ① GraphQL（api.github.com/graphql，权威源，schema 稳定）
           ↓ 失败
     ② HTML 抓取（github.com/users/<login>/contributions，零鉴权）
           ↓ 失败
     ③ 什么都不写，退出非 0 —— 构建继续用仓库里已提交的兜底快照

   ② 是回退路径，只在快照已经陈旧时才启用：见 STALE_DAYS。
   两个源对不上：GraphQL 1947 / HTML 1950，5 天不一致，呈「相邻日互相搬」
   的模式（08-30 +2 / 08-31 −2，09-07 +3 / 09-08 −3），是归日口径不同
   （时区或分桶），不是漏算。所以能走 ① 就走 ①。

   鉴权：优先 GH_TOKEN / GITHUB_TOKEN 环境变量（CI 里由 workflow 注入），
   本地没有就退回 `gh auth token`。两个都没有就直接跳去 ②。

   用法：
     node scripts/fetch-contrib.mjs
   跑完 git diff 看一眼，然后连同贡献图一起提交。

   只写一份连续 N 天的原始数组，四张图的窗口和分层都由 ContribCharts.vue
   自己推（slice(-90) / slice(-60) / 分层计数），不在这里预先切好。
   ============================================================================ */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LOGIN = 'Jack11111eee'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', '.vitepress', 'theme', 'contrib-data.js')

/* 快照超过这个天数，才允许启用 HTML 回退。
   理由：回退路径的数字和 GraphQL 对不上（归日口径不同），会让人以为图上
   数字「莫名其妙变了」。所以只在「数据已经很旧」和「数字有轻微漂移」之间
   选前者——旧数据的危害更大。 */
const STALE_DAYS = 3

const DAY = 86400000
const today = () => new Date().toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

/* ── 读现有快照 ─────────────────────────────────────────────────────────── */
function readSnapshot() {
  try {
    const src = readFileSync(OUT, 'utf8')
    const fetchedAt = /fetchedAt:\s*'([^']+)'/.exec(src)?.[1]
    const start = /start:\s*'([^']+)'/.exec(src)?.[1]
    const total = Number(/total:\s*(\d+)/.exec(src)?.[1])
    const days = JSON.parse('[' + /days:\s*\[([^\]]*)\]/.exec(src)[1] + ']')
    return { fetchedAt, start, total, days }
  } catch {
    return null
  }
}

/* ── 校验：两个源都要过这一关 ─────────────────────────────────────────────
   这是防「GitHub 改版后静默写入垃圾数据」的唯一防线。 */
function validate(days, start, label) {
  const bad = (why) => {
    throw new Error(`${label} 数据不合格：${why}`)
  }
  if (!Array.isArray(days) || days.length < 360 || days.length > 372)
    bad(`天数 ${days?.length}，不在 360–372 之间`)
  if (days.some((v) => !Number.isInteger(v) || v < 0)) bad('有非负整数之外的取值')
  const total = days.reduce((a, b) => a + b, 0)
  if (total <= 0) bad('合计为 0')
  const base = Date.parse(start + 'T00:00:00Z')
  if (!Number.isFinite(base)) bad(`起始日期 ${start} 解析不了`)
  for (let i = 1; i < days.length; i++) {
    if (Date.parse(isoAt(base, i)) - Date.parse(isoAt(base, i - 1)) !== DAY)
      bad(`第 ${i} 天日期不连续`)
  }
  return total
}
const isoAt = (baseMs, i) => new Date(baseMs + i * DAY).toISOString().slice(0, 10)

/* ── ① GraphQL ─────────────────────────────────────────────────────────── */
async function viaGraphQL() {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    } catch {
      throw new Error('没有可用 token（GH_TOKEN / GITHUB_TOKEN / gh auth 都没有）')
    }
  }
  const query = `query { user(login: "${LOGIN}") {
    contributionsCollection { contributionCalendar {
      totalContributions
      weeks { contributionDays { date contributionCount } }
    } } } }`
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'my-cs-wiki-contrib-fetch',
    },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`)
  const json = await res.json()
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '))
  const cal = json.data?.user?.contributionsCollection?.contributionCalendar
  if (!cal) throw new Error('响应里没有 contributionCalendar')
  const flat = cal.weeks.flatMap((w) => w.contributionDays)
  return { start: flat[0].date, days: flat.map((d) => d.contributionCount), total: cal.totalContributions }
}

/* ── ② HTML 抓取 ─────────────────────────────────────────────────────────
   页面里每天一个 <td id=... data-date=...>，配套一个 <tool-tip for=该id>
   写着 "224 contributions on September 8th." 或 "No contributions on ..."。
   注意两点：tooltip 文本里没有年份，日期只能从 <td> 取；<td> 的属性顺序
   不保证，所以按整段标签正则取，不依赖先后。 */
async function viaHTML() {
  const res = await fetch(`https://github.com/users/${LOGIN}/contributions`, {
    headers: { 'User-Agent': 'my-cs-wiki-contrib-fetch' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  const id2date = {}
  for (const m of html.matchAll(/<td\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1]
    const date = /\bdata-date="([^"]+)"/.exec(m[0])?.[1]
    if (id && date) id2date[id] = date
  }
  const byDate = {}
  for (const m of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = id2date[m[1]]
    if (!date) continue
    const text = m[2]
    if (/^\s*No contribution/i.test(text)) byDate[date] = 0
    else {
      const n = /(\d[\d,]*)\s+contribution/i.exec(text)
      if (n) byDate[date] = Number(n[1].replace(/,/g, ''))
    }
  }
  const dates = Object.keys(byDate).sort()
  if (!dates.length) throw new Error('一个日期都没解析出来（页面结构可能变了）')
  const start = dates[0]
  const base = Date.parse(start + 'T00:00:00Z')
  const days = []
  for (let i = 0; i < dates.length; i++) {
    const want = isoAt(base, i)
    if (dates[i] !== want) throw new Error(`日期不连续：期望 ${want}，实际 ${dates[i]}`)
    days.push(byDate[dates[i]])
  }
  return { start, days, total: days.reduce((a, b) => a + b, 0) }
}

/* ── 落盘 ───────────────────────────────────────────────────────────────── */
function write(data, source) {
  const fetchedAt = today()
  const file = `/* 由 scripts/fetch-contrib.mjs 生成，不要手改。
   数据源：GitHub GraphQL contributionsCollection.contributionCalendar
   账号：${LOGIN} · 窗口：滚动一年 · 抓取于 ${fetchedAt}
   来源：${source}
   ${source === 'graphql' ? '' : '（非 GraphQL：数字与 GraphQL 源可能有 1–3 的漂移，见脚本注释）'}

   days 是连续 ${data.days.length} 天的每日贡献数，从 ${data.start} 起。
   四张图共用这一份：条形码取 slice(-90)、面积图取 slice(-60)、
   漏斗按阈值分层，窗口起点都在 ContribCharts.vue 里推。 */
export const CONTRIB = {
  login: '${LOGIN}',
  start: '${data.start}',
  fetchedAt: '${fetchedAt}',
  source: '${source}',
  total: ${data.total},
  days: [${data.days.join(', ')}],
}
`
  writeFileSync(OUT, file)
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
const snapshot = readSnapshot()
const age = snapshot ? daysBetween(snapshot.fetchedAt, today()) : Infinity
console.log(`现有快照：${snapshot ? `${snapshot.fetchedAt}（${age} 天前）` : '没有'}`)

let data = null
let source = null

try {
  data = await viaGraphQL()
  source = 'graphql'
  console.log('① GraphQL 成功')
} catch (e) {
  console.log(`① GraphQL 失败：${e.message}`)
}

if (!data) {
  if (age > STALE_DAYS) {
    try {
      data = await viaHTML()
      source = 'html'
      console.log(`② HTML 回退成功（快照已陈旧 ${age} 天，超过阈值 ${STALE_DAYS} 天）`)
    } catch (e) {
      console.log(`② HTML 回退失败：${e.message}`)
    }
  } else {
    console.log(`② 跳过 HTML 回退：快照才 ${age} 天，未超过阈值 ${STALE_DAYS} 天`)
  }
}

if (!data) {
  if (snapshot && age <= STALE_DAYS) {
    console.log(`③ 保留现有快照（${snapshot.fetchedAt}），构建继续`)
    process.exit(0)
  }
  console.error(`③ 两个源都拿不到数据，且快照${snapshot ? `已陈旧 ${age} 天` : '不存在'}——需要人工介入`)
  process.exit(1)
}

try {
  const total = validate(data.days, data.start, source)
  console.log(`校验通过：${data.days.length} 天 · 合计 ${total} · ${data.start} 起`)
} catch (e) {
  console.error(`校验失败：${e.message}`)
  process.exit(1)
}

write(data, source)
console.log(`已写入 ${OUT}（来源 ${source}）`)
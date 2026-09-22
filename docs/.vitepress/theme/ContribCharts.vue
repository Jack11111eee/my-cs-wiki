<script setup>
/* ============================================================================
   贡献图表 · 四张样式
   图型骨架与尺度参数来自 design-refs/contrib-charts（Lupi/Basics 的 L17 / L3 /
   F3 / L13），那边逐条记的坑照搬：点面积按最大值反推、条形码峰值标注放宽到
   top-2 间隔 ≥3 天、面积图用原生 400×320 几何不拉伸、漏斗一 tick = 两天。

   跟那边存档不同的两处：
   1. 颜色。Mono 是「明度即数据、没有彩色」，这里保留这个逻辑，墨色换成站点
      正文色，灰阶 ladder 由站点色阶替换。全部走 CSS 变量，所以日夜切换是纯
      CSS，SVG 不用重画。
   2. 数据。那边四张图各存一份写死的数组和文案数字；这里只存一份 366 天的
      原始数组（contrib-data.js），窗口、分层、副标题里的每个数字都在这里推。
      滚动窗口下数据会变，写死必然过期——重跑 scripts/fetch-contrib.mjs 就行。
   ============================================================================ */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { CONTRIB } from './contrib-data.js'

const elCalheat = ref(null)
const elBarcode = ref(null)
const elHairarea = ref(null)
const elHourglass = ref(null)
const elTip = ref(null)

/* ── 数据 ────────────────────────────────────────────────────────────────
   days 是连续 N 天的每日贡献数。四张图共用这一份：
   条形码取末 90 天、面积图取末 60 天、漏斗按阈值分层。 */
const DAYS = CONTRIB.days
const START = CONTRIB.start
const N = DAYS.length
const TOTAL = CONTRIB.total
const sum = (a) => a.reduce((x, y) => x + y, 0)

const dateAt = (i) => {
  const t = new Date(START + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + i)
  return t
}
const isoOf = (i) => dateAt(i).toISOString().slice(0, 10)

const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
// 月份标签：取每月第一次出现的那天，返回它在序列里的下标（各图自己换算成 x）
const monthMarks = (from, len) => {
  const out = []
  for (let i = 0; i < len; i++) {
    const dt = dateAt(from + i)
    if (i === 0 || dt.getUTCDate() === 1) out.push([MONTH_ABBR[dt.getUTCMonth()], i])
  }
  return out
}

const BAR_LEN = 90, AREA_LEN = 60
const BAR = DAYS.slice(-BAR_LEN), BAR_FROM = N - BAR_LEN
const AREA = DAYS.slice(-AREA_LEN), AREA_FROM = N - AREA_LEN

const PEAK = DAYS.indexOf(Math.max(...DAYS))
const PEAK_V = DAYS[PEAK]
const PEAK_MONTH = MONTH_ABBR[dateAt(PEAK).getUTCMonth()].toLowerCase()

const STAGES = [
  ['ALL DAYS', N],
  ['ANY WORK', DAYS.filter((v) => v > 0).length],
  ['5+ DAYS', DAYS.filter((v) => v >= 5).length],
  ['20+ DAYS', DAYS.filter((v) => v >= 20).length],
  ['60+ DAYS', DAYS.filter((v) => v >= 60).length],
]

// 四张图共用的说明文案，日期和数字都从数据推
const RANGE = `${isoOf(0)} → ${isoOf(N - 1)}`
const BAR_RANGE = `${isoOf(BAR_FROM)} → ${isoOf(N - 1)}`
const AREA_RANGE = `${isoOf(AREA_FROM)} → ${isoOf(N - 1)}`

/* ── SVG 小工具 ──────────────────────────────────────────────────────────
   fill/stroke 是 var() 时必须走 style——SVG 的属性不认 var()，只有 style 认。 */
const NS = 'http://www.w3.org/2000/svg'
const el = (p, t, a) => {
  const n = document.createElementNS(NS, t)
  const st = []
  for (const k in a) {
    if (k === 'style') continue
    if ((k === 'fill' || k === 'stroke') && String(a[k]).startsWith('var(')) {
      st.push(`${k}:${a[k]}`)
      continue
    }
    n.setAttribute(k, a[k])
  }
  if (a.style) st.push(a.style)
  if (st.length) n.setAttribute('style', st.join(';'))
  p.appendChild(n)
  return n
}
const txt = (p, a, s) => {
  const n = el(p, 'text', a)
  n.textContent = s
  return n
}
const rnd = (i, k) => Math.abs(((i * 73856093) ^ (k * 19349663)) % 1000) / 1000

let observers = []

onMounted(() => {
  const tipEl = elTip.value
  const WD_SUN = ['SUN','MON','TUE','WED','THU','FRI','SAT']

  /* ── 悬浮提示 ──────────────────────────────────────────────────────────
     取代模板里的 tip()（SVG 原生 <title>，浏览器默认样式、有延迟、改不了）。
     一个浮层全局共用，跟随鼠标，配色跟图内墨色同一套令牌（见下方 style）。
     点最小只有 r=.75、发丝只有 .55 宽，直接 hover 本体命中不了，
     所以每张图另外铺一层透明命中区，按格/按列铺满。 */
  const moveTip = (e) => {
    const r = tipEl.getBoundingClientRect()
    let x = e.clientX + 14
    let y = e.clientY + 16
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 16
    tipEl.style.transform = `translate(${x}px,${y}px)`
  }
  const hit = (p, t, a, html) => {
    const n = el(p, t, Object.assign({}, a, { fill: 'transparent' }))
    n.style.pointerEvents = 'all'
    n.addEventListener('mouseenter', (e) => {
      tipEl.innerHTML = html
      tipEl.classList.add('on')
      moveTip(e)
    })
    n.addEventListener('mousemove', moveTip)
    n.addEventListener('mouseleave', () => tipEl.classList.remove('on'))
    return n
  }
  const dayTip = (i, v) =>
    `<b>${isoOf(i)}</b> <span class="wd">${WD_SUN[dateAt(i).getUTCDay()]}</span>` +
    `<br><span class="n">${v}</span> contribution${v === 1 ? '' : 's'}`
  const stageTip = (name, c, next) => {
    const line = next
      ? `<span class="wd">${Math.round(next[1] / c * 100)}% get through → ${next[0]}</span>`
      : `<span class="wd">100% of all days</span>`
    return `<b>${name}</b> <span class="n">${c.toLocaleString()}</span><br>${line}`
  }

  // 滚入视野才播，点击重播（Mono §9 obsReveal 原样，去掉 getElementById）
  const reveal = (svg, fn) => {
    if (!svg) return
    let timers = []
    const go = () => {
      timers.forEach(clearTimeout)
      timers = []
      svg.innerHTML = ''
      fn(svg)
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es[0].isIntersecting) {
          go()
          io.disconnect()
        }
      },
      { threshold: 0.3 },
    )
    io.observe(svg)
    observers.push(io)
    svg.style.cursor = 'pointer'
    svg.addEventListener('click', go)
  }

  /* ════ L17 · 日历热力 ════ */
  reveal(elCalheat.value, (s) => {
    const P = 13.4, X0 = 52, Y0 = 42
    // 尺度常数由数据最大值反推，使峰值点恰好填满一格（模板原值 1.55 对应 max≈18）
    const SCALE = (P / 2 - 0.6 - 1.1) / Math.sqrt(PEAK_V)
    // 周一起算的行号；首日未必是周一，所以列号要把首日的行偏移补回去
    const row0 = (dateAt(0).getUTCDay() + 6) % 7
    const colOf = (i) => Math.floor((i + row0) / 7)
    const rowOf = (i) => (dateAt(i).getUTCDay() + 6) % 7

    ;['MON', 'WED', 'FRI', 'SUN'].forEach((lab, k) => {
      txt(s, { x: X0 - 10, y: Y0 + k * 2 * P + 3, 'font-size': 6.5, 'font-weight': 700,
        fill: 'var(--c-muted)', 'text-anchor': 'end', 'letter-spacing': '.06em',
        class: 'fade', style: `animation-delay:${k * 0.04}s` }, lab)
    })
    monthMarks(0, N).forEach(([m, i], k) => {
      const x = X0 + colOf(i) * P
      txt(s, { x, y: Y0 - 16, 'font-size': 7, 'font-weight': 700, fill: 'var(--c-muted)',
        'letter-spacing': '.1em', class: 'fade', style: `animation-delay:${k * 0.03}s` }, m)
      el(s, 'line', { x1: x, y1: Y0 - 11, x2: x, y2: Y0 - 5, stroke: 'var(--c-faint)',
        'stroke-width': 0.7, class: 'fade', style: `animation-delay:${k * 0.03}s` })
    })

    DAYS.forEach((t, i) => {
      const x = X0 + colOf(i) * P, y = Y0 + rowOf(i) * P
      const delay = colOf(i) * 0.012 + rowOf(i) * 0.004
      if (!t) {
        el(s, 'circle', { cx: x, cy: y, r: 0.75, fill: 'var(--c-quiet)',
          class: 'pop', style: `animation-delay:${delay}s` })
        return
      }
      el(s, 'circle', { cx: x, cy: y, r: 1.1 + Math.sqrt(t) * SCALE,
        fill: t > PEAK_V * 0.66 ? 'var(--c-ink)' : t > PEAK_V * 0.33 ? 'var(--c-mid)' : 'var(--c-low)',
        class: 'pop', style: `animation-delay:${delay}s` })
    })

    // 峰值：虚线圈 + 旁注引线。峰值列靠右时引线改向左下走
    const px = X0 + colOf(PEAK) * P, py = Y0 + rowOf(PEAK) * P
    const pr = 1.1 + Math.sqrt(PEAK_V) * SCALE
    el(s, 'circle', { cx: px, cy: py, r: pr + 3.6, fill: 'none', stroke: 'var(--c-ink)',
      'stroke-width': 1, 'stroke-dasharray': '2 3', class: 'fade', style: 'animation-delay:1s' })
    el(s, 'path', { d: `M${px - 4} ${py + pr + 5} C${px - 6} ${py + 52} ${px - 46} ${py + 78} ${px - 92} ${py + 86}`,
      fill: 'none', stroke: 'var(--c-hair)', 'stroke-width': 0.7, class: 'fade',
      style: 'animation-delay:1.1s' })
    txt(s, { x: px - 96, y: py + 90, 'font-size': 7, fill: 'var(--c-mid)', 'font-style': 'italic',
      'text-anchor': 'end', class: 'fade', style: 'animation-delay:1.15s' },
      `the ${PEAK_MONTH} sprint — ${PEAK_V} contributions in a single day`)
    txt(s, { x: 420, y: 172, 'font-size': 7, 'font-weight': 600, fill: 'var(--c-hair)',
      'text-anchor': 'middle', 'letter-spacing': '.12em', class: 'fade',
      style: 'animation-delay:1.2s' },
      'ONE DOT = ONE DAY · DOT AREA = CONTRIBUTIONS · TINY DOT = A QUIET DAY')

    // 命中区：每格一个圆，半径正好半个格距，把整个网格铺满
    // （最小点半径 .75，直接 hover 点命中不了；空白日也要能 hover 出 0）
    DAYS.forEach((t, i) => {
      hit(s, 'circle', { cx: X0 + colOf(i) * P, cy: Y0 + rowOf(i) * P, r: P / 2 }, dayTip(i, t))
    })
  })

  /* ════ L3 · 条形码 ════ */
  reveal(elBarcode.value, (s) => {
    const STEP = 8.53, X0 = 18, BASE = 252
    BAR.forEach((_, d) => {
      const x = X0 + d * STEP
      el(s, 'line', { x1: x, y1: 8, x2: x, y2: 258, stroke: 'var(--c-grid)',
        'stroke-width': 0.7, class: 'fade', style: `animation-delay:${d * 0.004}s` })
    })
    // 纵轴尺度由数据最大值反推（模板原值 .75 对应 max≈336）
    const S = (BASE - 40) / Math.max(...BAR)
    // 标出最忙的两天。模板的 top-3 要求间隔 ≥6 天；这份数据的峰值全挤在
    // 9 月 5–9 日，放宽到 ≥3 天才能标到真正的第 1、2 名而不撞标签。
    const top = []
    ;[...BAR.keys()].sort((a, b) => BAR[b] - BAR[a]).forEach((d) => {
      if (top.length < 2 && top.every((t) => Math.abs(t - d) >= 3)) top.push(d)
    })
    BAR.forEach((v, d) => {
      const x = X0 + d * STEP
      const y = BASE - v * S
      const weekend = [0, 6].includes(dateAt(BAR_FROM + d).getUTCDay())
      const stemEnd = Math.min(256, y + 14 + rnd(d + 1, 9) * 26)
      el(s, 'line', { x1: x, y1: y, x2: x, y2: stemEnd, stroke: 'var(--c-ink)',
        'stroke-width': 1.1, class: 'fade', style: `animation-delay:${0.3 + d * 0.008}s` })
      const big = top.includes(d)
      el(s, 'circle', { cx: x, cy: y, r: big ? 4.6 : 2.7,
        fill: weekend ? 'var(--c-halo)' : 'var(--c-ink)', stroke: 'var(--c-ink)',
        'stroke-width': weekend ? 1.2 : 0, class: 'pop',
        style: `animation-delay:${0.3 + d * 0.008}s` })
      if (big)
        txt(s, { x, y: y - 10, 'font-size': 9, 'font-weight': 800, fill: 'var(--c-ink)',
          'text-anchor': 'middle', class: 'fade', style: `animation-delay:${0.9 + d * 0.004}s` }, v)
    })
    monthMarks(BAR_FROM, BAR_LEN).forEach(([m, d]) =>
      txt(s, { x: X0 + d * STEP, y: 276, 'font-size': 8, 'font-weight': 600,
        fill: 'var(--c-muted)', 'letter-spacing': '.12em', class: 'fade' }, m))
    // 命中区：一天一条整列（发丝只有 .7 宽，点也只有 2.7，直接 hover 命中不了）
    BAR.forEach((v, d) => {
      hit(s, 'rect', { x: X0 + d * STEP - STEP / 2, y: 0, width: STEP, height: 270 },
        dayTip(BAR_FROM + d, v))
    })
  })

  /* ════ F3 · 发丝面积 ════ */
  reveal(elHairarea.value, (s) => {
    // 用模板原生几何，不拉伸画布：原生 viewBox 400×320，日距 6.0 是为容纳 60 天
    const x = (d) => 28 + d * 6.0, BASE = 262
    const MAXV = Math.max(...AREA)
    // 纵轴尺度由数据最大值反推，使峰值恰好顶到上沿（模板原值 2.35 对应 max≈94）
    const S = (BASE - 40) / MAXV
    const map = (v) => BASE - v * S
    el(s, 'line', { x1: 22, y1: BASE, x2: 378, y2: BASE, stroke: 'var(--c-grid)',
      'stroke-width': 0.8, class: 'fade' })
    const peak = AREA.indexOf(MAXV)
    AREA.forEach((v, d) => {
      el(s, 'line', { x1: x(d), y1: BASE, x2: x(d), y2: map(v),
        stroke: d === peak ? 'var(--c-ink)' : 'var(--c-muted)',
        'stroke-width': d === peak ? 1.1 : 0.55,
        opacity: d === peak ? 1 : 0.55 + rnd(d + 1, 7) * 0.45,
        class: 'fade', style: `animation-delay:${d * 0.014}s` })
    })
    // 顶边轮廓：连起每天的峰值
    const pts = AREA.map((v, d) => `${x(d)} ${map(v)}`).join(' L ')
    el(s, 'path', { d: 'M' + pts, fill: 'none', stroke: 'var(--c-ink)', 'stroke-width': 1.2,
      pathLength: 1, class: 'draw', style: 'animation-delay:.4s;animation-duration:1.2s' })
    el(s, 'circle', { cx: x(peak), cy: map(MAXV), r: 4.2, fill: 'var(--c-ink)',
      class: 'pop', style: 'animation-delay:1.2s' })
    txt(s, { x: x(peak), y: map(MAXV) - 11, 'font-size': 9.5, 'font-weight': 800,
      fill: 'var(--c-ink)', 'text-anchor': 'middle',
      style: `paint-order:stroke;stroke:var(--c-halo);stroke-width:3px;animation-delay:1.3s`,
      class: 'fade' }, String(MAXV))
    monthMarks(AREA_FROM, AREA_LEN).forEach(([m, d]) =>
      txt(s, { x: x(d), y: BASE + 18, 'font-size': 7.5, 'font-weight': 600, fill: 'var(--c-muted)',
        'text-anchor': 'middle', 'letter-spacing': '.1em', class: 'fade' }, m))
    txt(s, { x: 200, y: 306, 'font-size': 7, 'font-weight': 600, fill: 'var(--c-hair)',
      'text-anchor': 'middle', 'letter-spacing': '.12em', class: 'fade',
      style: 'animation-delay:1.3s' }, 'ONE HAIRLINE = ONE DAY, FLOOR TO PEAK')
    // 命中区：一天一条整列，只铺到基线为止（下面留出月份标签和底注）
    AREA.forEach((v, d) => {
      hit(s, 'rect', { x: x(d) - 3, y: 0, width: 6, height: BASE }, dayTip(AREA_FROM + d, v))
    })
  })

  /* ════ L13 · 漏斗 ════ */
  reveal(elHourglass.value, (s) => {
    const CX = 185, TICK = 2 // 一 tick = 两天
    const sy = (k) => 34 + k * 64
    const w = (c) => (c / STAGES[0][1]) * 290
    STAGES.forEach(([name, c], k) => {
      const y = sy(k), hw = w(c) / 2
      // 带宽 ∝ 该层天数，tick 数也 ∝ 天数，所以各层 tick 间距恒定，
      // 肌理从最宽到最窄一致
      const n = Math.max(1, Math.round(c / TICK))
      for (let t = 0; t < n; t++) {
        const xt = CX - hw + ((t + 0.5) / n) * hw * 2 + (rnd(t + 1, k + 3) - 0.5) * 3
        el(s, 'line', { x1: xt, y1: y - 6, x2: xt, y2: y + 6, stroke: 'var(--c-ink)',
          'stroke-width': 0.8, opacity: 0.45 + rnd(t + 2, k + 5) * 0.5,
          class: 'fade', style: `animation-delay:${k * 0.12 + t * 0.004}s` })
      }
      if (k < STAGES.length - 1) {
        const hw1 = w(STAGES[k + 1][1]) / 2
        for (let t = 0; t < 34; t++) {
          const xt = CX + (rnd(t + 1, k * 7 + 1) - 0.5) * 2 * hw * 0.94
          const xb = CX + (rnd(t + 3, k * 7 + 5) - 0.5) * 2 * hw1 * 0.94
          el(s, 'path', { d: `M${xt} ${y + 8} C${xt} ${y + 34} ${xb} ${sy(k + 1) - 34} ${xb} ${sy(k + 1) - 8}`,
            fill: 'none', stroke: 'var(--c-hair)', 'stroke-width': 0.5, opacity: 0.32,
            pathLength: 1, class: 'draw',
            style: `animation-delay:${0.2 + k * 0.15 + t * 0.008}s;animation-duration:.8s` })
        }
        const pct = Math.round((STAGES[k + 1][1] / c) * 100)
        txt(s, { x: 26, y: (y + sy(k + 1)) / 2 + 3, 'font-size': 8.5, 'font-weight': 800,
          fill: 'var(--c-muted)', class: 'fade', style: `animation-delay:${0.5 + k * 0.15}s` }, pct + '%')
        // 模板原生 6px，低于 skill 半宽卡下限 6.5px，按「沿用模板骨架」留
        txt(s, { x: 26, y: (y + sy(k + 1)) / 2 + 13, 'font-size': 6, 'font-weight': 600,
          fill: 'var(--c-faint)', 'letter-spacing': '.08em', class: 'fade',
          style: `animation-delay:${0.5 + k * 0.15}s` }, 'GET THROUGH')
      }
      // 层标签，引线连到横带边缘
      el(s, 'line', { x1: Math.min(CX + hw + 6, 340), y1: y, x2: 340, y2: y,
        stroke: 'var(--c-grid)', 'stroke-width': 0.8, class: 'fade',
        style: `animation-delay:${0.3 + k * 0.12}s` })
      txt(s, { x: 344, y: y - 1, 'font-size': 7.5, 'font-weight': 700, fill: 'var(--c-mid)',
        'letter-spacing': '.08em', class: 'fade', style: `animation-delay:${0.35 + k * 0.12}s` }, name)
      txt(s, { x: 344, y: y + 10, 'font-size': 9.5, 'font-weight': 800, fill: 'var(--c-ink)',
        class: 'fade', style: `animation-delay:${0.4 + k * 0.12}s` }, c.toLocaleString())
      // 命中区：整行一条，从最左一直铺到标签右端。
      // 最窄那层（60+ DAYS）横带实际只有几个像素宽，只铺横带的话根本 hover 不到，
      // 所以连同标签一起圈进来。
      hit(s, 'rect', { x: 18, y: y - 16, width: 362, height: 32 }, stageTip(name, c, STAGES[k + 1]))
    })
  })
})

onBeforeUnmount(() => {
  observers.forEach((o) => o.disconnect())
  observers = []
})
</script>

<template>
  <div class="contrib">
    <div ref="elTip" class="chart-tip" />

    <section class="chart-card">
      <div class="chart-badge">LUPI 编辑型 · 日历热力</div>
      <div class="chart-title">A quiet year, then September</div>
      <div class="chart-sub">{{ RANGE }} · one dot = one day · dot area = contributions that day · tiny dot = a quiet day · dashed ring = the busiest day</div>
      <svg ref="elCalheat" viewBox="0 0 840 188" preserveAspectRatio="xMidYMid meet" />
      <div class="chart-src">CALENDAR HEAT · MONO-EDITORIAL · GITHUB CONTRIBUTIONS · {{ CONTRIB.login }}</div>
    </section>

    <section class="chart-card">
      <div class="chart-split">
        <div>
          <div class="chart-badge">LUPI 编辑型 · 条形码</div>
          <div class="chart-title">Ninety days that hold {{ Math.round(sum(BAR) / TOTAL * 100) }}% of the year</div>
          <div class="chart-sub">daily contributions · {{ BAR_RANGE }} · {{ sum(BAR).toLocaleString() }} of the year's {{ TOTAL.toLocaleString() }}</div>
          <div class="chart-note">Every hairline is a day, whether or not anything
          happened in it. The dot marks the day's count; the stem below it is
          just gravity. Read the field, not the numbers — the sprint has a
          texture before it has a value.</div>
          <div class="chart-legend">
            ● &nbsp;WEEKDAY<br>
            ○ &nbsp;WEEKEND<br>
            │ &nbsp;ONE CALENDAR DAY<br>
            ◉ &nbsp;BUSIEST DAYS, LABELED
          </div>
        </div>
        <div>
          <svg ref="elBarcode" viewBox="0 0 800 300" preserveAspectRatio="xMidYMid meet" />
          <div class="chart-src">BARCODE LOLLIPOP · MONO-EDITORIAL · GITHUB CONTRIBUTIONS · {{ CONTRIB.login }}</div>
        </div>
      </div>
    </section>

    <section class="chart-card chart-card--narrow">
      <div class="chart-badge">LUPI 基础型 · 面积</div>
      <div class="chart-title">Sixty days: a long floor, then a cliff</div>
      <div class="chart-sub">one hairline = one day, floor to peak · {{ AREA_RANGE }} · {{ sum(AREA).toLocaleString() }} contributions</div>
      <svg ref="elHairarea" viewBox="0 0 400 320" preserveAspectRatio="xMidYMid meet" />
      <div class="chart-src">HAIRLINE AREA · MONO-BASIC · GITHUB CONTRIBUTIONS · {{ CONTRIB.login }}</div>
    </section>

    <section class="chart-card chart-card--narrow">
      <div class="chart-badge">LUPI 编辑型 · 漏斗</div>
      <div class="chart-title">Of {{ N }} days, {{ STAGES[4][1] }} did the heavy lifting</div>
      <div class="chart-sub">one tick = two days · 5+ / 20+ / 60+ = contributions that day · {{ RANGE }}</div>
      <svg ref="elHourglass" viewBox="0 0 400 330" preserveAspectRatio="xMidYMid meet" />
      <div class="chart-src">HOURGLASS STREAM · MONO-EDITORIAL · GITHUB CONTRIBUTIONS · {{ CONTRIB.login }}</div>
    </section>

    <p class="contrib-foot">
      {{ N }} 天 · 合计 {{ TOTAL.toLocaleString() }} 次贡献 · 数据抓取于 {{ CONTRIB.fetchedAt }}<template
        v-if="CONTRIB.source && CONTRIB.source !== 'graphql'"
      >（{{ CONTRIB.source === 'html' ? 'HTML 回退，数字与 GraphQL 源有 1–3 的漂移' : '仓库快照' }}）</template>。
      每日自动刷新；本地重跑 <code>scripts/fetch-contrib.mjs</code> 也可更新。
    </p>
  </div>
</template>

<style>
/* 这一块是全局的（没有 scoped）：图表里的元素是 JS 用 createElementNS 建的，
   拿不到 scoped 的 data 属性，scoped 样式对它们不生效。
   颜色令牌跟站点主题同一套，切 .dark 是纯 CSS，SVG 不用重画。 */

/* 图内灰阶 ladder：峰值 → 静默日。Mono 的「明度即数据」保留，色相换成站点正文色 */
:root {
  --c-ink: #46283a;
  --c-mid: #6b4a5c;
  --c-low: #a3818d;
  --c-quiet: #d8c9d0;
  --c-muted: #8a6774;   /* 次级文字、轴标签 */
  --c-faint: #c2a7b2;   /* 来源行、辅助刻度 */
  --c-hair: #b9a0aa;    /* 发丝线、引线 */
  --c-grid: rgba(206, 158, 174, 0.5);
  --c-halo: #fbf3f6;    /* 实色「纸」：空心点填充、数字描边 */
}
.dark {
  --c-ink: #ecf2ff;
  --c-mid: #a8bde0;
  --c-low: #7e94ba;
  --c-quiet: #3a4a6e;
  --c-muted: #8fa4c8;
  --c-faint: #5b6d92;
  --c-hair: #5d729b;
  --c-grid: rgba(122, 154, 208, 0.28);
  --c-halo: #101a33;
}

/* 卡片：走站点面板令牌，不用模板的米白底。
   无边框：Mono 原样就是「卡片无边框，靠留白分卡」。 */
.contrib .chart-card {
  background: var(--wiki-panel);
  border-radius: 22px;
  padding: 30px 32px 22px;
  margin-bottom: 30px;
}
.contrib .chart-title {
  font-family: var(--wiki-font-serif);
  font-weight: 400;
  font-size: 19px;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  margin-bottom: 4px;
}
.contrib .chart-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--c-muted);
  margin-bottom: 10px;
}
.contrib .chart-sub {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--c-muted);
  margin-bottom: 14px;
}
.contrib .chart-src {
  font-family: var(--vp-font-family-mono);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--c-faint);
  margin-top: 10px;
}
.contrib .chart-note {
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
  margin-bottom: 16px;
}
.contrib .chart-legend {
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.1em;
  line-height: 2;
  color: var(--c-muted);
}
.contrib .chart-split {
  display: grid;
  grid-template-columns: 250px 1fr;
  gap: 30px;
  align-items: start;
}
@media (max-width: 760px) {
  .contrib .chart-split { grid-template-columns: 1fr; gap: 18px; }
}
/* 面积与漏斗是竖构图（原生 viewBox 400×320 / 400×330），撑满宽栏会长得过高、
   把另外两张横构图压没，所以限宽居中。860px 时面积图约 690px 高，发丝间距
   约 13px、漏斗整行命中区仍有 360px 宽，命中都很舒服。 */
.contrib .chart-card--narrow svg { max-width: 860px; margin: 0 auto; }

.contrib svg { width: 100%; height: auto; display: block; }
.contrib svg text { font-family: var(--vp-font-family-base); }

/* 悬浮提示：Mono 的 tipLight / tipDark 是「浅卡黑底纸字、暗卡纸底黑字」这一对
   反转，站点里卡片明暗由 .dark 决定，所以直接落到 --c-ink / --c-halo 上。 */
.contrib .chart-tip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 20;
  pointer-events: none;
  padding: 9px 12px;
  border-radius: 10px;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.55;
  background: var(--c-ink);
  color: var(--c-halo);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.contrib .chart-tip.on { opacity: 1; }
.contrib .chart-tip b {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.contrib .chart-tip .wd { opacity: 0.62; font-size: 10px; letter-spacing: 0.06em; }
.contrib .chart-tip .n { font-weight: 800; font-size: 13px; }

.contrib .contrib-foot {
  font-size: 12px;
  line-height: 1.8;
  color: var(--vp-c-text-3);
  margin-top: -8px;
}
.contrib .contrib-foot code {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  background: var(--vp-code-bg);
  color: var(--vp-code-color);
  padding: 2px 6px;
  border-radius: 5px;
}

/* 入场动画（Mono MOTION.css 原样） */
.contrib .pop { transform-box: fill-box; transform-origin: center;
  animation: contrib-pop 0.5s cubic-bezier(0.2, 0.7, 0.3, 1.3) both; }
@keyframes contrib-pop { from { transform: scale(0); } to { transform: none; } }
.contrib .fade { animation: contrib-fade 0.9s ease both; }
@keyframes contrib-fade { from { opacity: 0; } }
.contrib .draw { stroke-dasharray: 1; stroke-dashoffset: 1;
  animation: contrib-draw 1s cubic-bezier(0.4, 0, 0.2, 1) both; }
@keyframes contrib-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .contrib .pop, .contrib .fade { animation: none; }
  .contrib .draw { animation: none; stroke-dasharray: none; stroke-dashoffset: 0; }
}
</style>
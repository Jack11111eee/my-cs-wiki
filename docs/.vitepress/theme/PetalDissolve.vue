<script setup>
/* 顶栏下方的「沙粒消散」。
   ---------------------------------------------------------------------------
   要解决的问题：顶栏是透明的，正文滚到它下面就会和导航链接糊在一起。
   以前靠顶栏自己的 backdrop-filter 把正文糊掉。现在改成：正文在顶栏这一带
   一点点碎成沙粒，越往上散得越彻底，到屏幕最顶上完全散尽。

   消散线 = 顶栏底边。消弥梯度从这条线**往上**铺，正好铺满顶栏那 64px：
     刚碰到线的字     —— 还很清楚，只掉几粒沙
     线往上走一半     —— 半消弥，字还在但明显在散
     屏幕最顶         —— 字没了，只剩沙云，再淡出
   所以静止时顶栏下方不会平白少一行，文字贴着顶栏底边也是完整的。

   沙粒是**挂在行盒上**的，不是钉在屏幕上：每粒沙记的是「在本行里的相对位置」，
   每帧按行盒当前的位置算屏幕坐标。于是沙粒天然跟着文字一起往上走，
   就像文字本身变成了沙；往回滚时行的消散度降下来，沙粒就落回去、文字重新凝聚。

   沙粒的随机与运动（散开方向、时序偏移、漂浮、落地抖动、尺寸与透明度）
   和首页开场那套是同一份代码，见 grains.js。这里只负责时间轴——
   首页是一次性动画，这里是滚动驱动：t = 1 − 这一格的消散度。

   为什么用 mask 而不是把每个字包成 <span>：
   逐字包 span 能拿到最精确的碎裂效果，但会牵动拉丁文断行、::marker 列表序号、
   <a> 下划线、行内 code 底色、代码块底色，每个都得单独打补丁，而且动过 DOM
   之后将来开本地搜索会打坏它的高亮。mask 一次性把所有东西统一吃掉，且不动 DOM。
   沙粒位置改用 Range.getClientRects() 拿真实字符行盒，所以照样是从字上飞出来的。

   可访问性：prefers-reduced-motion 下整个不启动，由 custom.css 把顶栏的 blur 放回来。
   窄屏（<960px）不启用——顶栏在窄屏是不透明的，正文不会从它下面过。 */
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import { GRAIN_DEFAULTS, grainD, hash2, makeGrain, grainState } from './grains.js'

const canvasEl = ref(null)
const route = useRoute()

const CFG = {
  ...GRAIN_DEFAULTS, // 沙粒的随机与运动参数，和首页开场共用（见 grains.js）
  curve: 1.5, // 消散曲线指数。越大，越靠近消弥线的字越"扛得住"，越往顶散得越快
  maxCols: 90, // 单行横向格数上限，防止超长行炸掉
  cellH: 11, // 纵向格子的基准高度，行高按它切行数
  maxRows: 3, // 单行纵向格数上限
  maskStep: 3, // mask 台阶高度（px）。段内 alpha 恒定，段间硬跳
  // 这一带只有 64px 高，飞散范围收窄到首页的三分之一——
  // 按首页那 150px 散，沙会盖到下面完整可读的正文上。
  spread: 50,
  swirl: 25,
}

// 消散度：t = 0 刚好碰到消弥线，t = 1 屏幕最顶
function dissolveAt(t) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return Math.pow(t, CFG.curve)
}

function createEngine(canvas) {
  const ctx = canvas.getContext('2d')
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const narrow = matchMedia('(max-width: 959px)')

  let dpr = 1
  let W = 0
  let H = 0
  let stripH = 0 // 画布高度：沙粒只可能出现在顶部这一条，见 measure()
  let target = null // { el, docTop }  正文容器，只会有一个
  let lines = [] // [{ x0,x1,top,bot, cols,rows,ds,color, grains:Map }]  行盒，文档坐标
  let chromeBottom = 64
  let raf = 0
  let running = false // 主循环在跑
  let active = false // 效果处于启用状态（可能正闲着没在跑循环）
  let lastMaskKey = ''
  let remeasureTimer = 0
  let ro = null
  let roW = 0 // 上一次 ResizeObserver 报的尺寸，见 measure() 里的说明
  let roH = 0
  let themeObs = null

  /* ---------- 测量 ---------- */

  // 顶部那一坨 chrome 的底边：顶栏 + 960~1280px 之间会出现的 VPLocalNav
  function readChromeBottom() {
    let b = 0
    const nav = document.querySelector('.VPNavBar')
    if (nav) b = Math.max(b, nav.getBoundingClientRect().bottom)
    const local = document.querySelector('.VPLocalNav')
    if (local && getComputedStyle(local).display !== 'none') {
      b = Math.max(b, local.getBoundingClientRect().bottom)
    }
    return b || 64
  }

  // 行盒只在这里读一次，之后每帧纯算术。
  // 同时把每条行盒切成 cols × rows 的格点——沙粒不再是随机撒在行里，
  // 而是一格一粒，于是消散看起来是"按格点碎开"而不是"糊成一片"。
  // 每格的时序偏移 d 也在这里算好（Float32Array），每帧再算的话是白烧 CPU。
  // 每行还要记下这行文字的计算色，沙粒就用它——正文基本单色，
  // 这样沙云的颜色天然跟主题走（白天深梅子、夜晚近白）。
  function collectLines(root, sy) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const p = n.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        // 标题后面那个 # 锚点、给读屏用的隐藏文字，都不参与
        if (p.closest('.header-anchor, .visually-hidden, script, style'))
          return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const range = document.createRange()
    let li = 0
    while (walker.nextNode()) {
      const color = getComputedStyle(walker.currentNode.parentElement).color
      range.selectNodeContents(walker.currentNode)
      const rects = range.getClientRects()
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue
        const cols = Math.max(
          1,
          Math.min(CFG.maxCols, Math.round(r.width / CFG.density)),
        )
        const rows = Math.max(
          1,
          Math.min(CFG.maxRows, Math.round(r.height / CFG.cellH)),
        )
        const n = cols * rows
        const ds = new Float32Array(n)
        for (let k = 0; k < n; k++) {
          const col = k % cols
          const row = (k - col) / cols
          ds[k] = grainD(col, row, li, CFG)
        }
        lines.push({
          x0: r.left,
          x1: r.right,
          top: r.top + sy,
          bot: r.bottom + sy,
          cols,
          rows,
          ds,
          color,
          seed: li, // 给 grains.js 的 hash 用，让相邻两行的沙不长得一模一样
          // 格子索引 → 沙粒。用 Map 而不是数组：格子的激活顺序由 hash 决定，
          // 不是按下标顺序来的，数组会留一堆洞。
          grains: new Map(),
        })
        li++
      }
    }
  }

  function measure() {
    const sy = window.scrollY
    chromeBottom = readChromeBottom()
    // 只认正文页。首页永不滚动（内容比一屏矮），顶栏带消散对它没有意义；
    // 而且首页的 mask 归 HomeCondense.vue 管，这里再插一手两边会打架。
    const el = document.querySelector('.VPDoc .vp-doc')
    target = el ? { el, docTop: el.getBoundingClientRect().top + sy } : null
    lines = []
    if (target) collectLines(target.el, sy)
    lastMaskKey = ''
    if (ro) ro.disconnect()
    if (target) {
      // 首次 observe() 一定会立刻回调一次，那次只用来记基准尺寸、不触发重测——
      // 否则就是：measure() → observe() → 回调 → scheduleRemeasure() → 150ms 后
      // measure() → observe() …… 每 150ms 空转一轮。这一轮会把 lines 整个丢掉重建，
      // 正在飞的沙粒跟着被清空，滚动时消散会一顿一顿的。
      let primed = false
      ro = new ResizeObserver((entries) => {
        const r = entries[0].contentRect
        const w = Math.round(r.width)
        const h = Math.round(r.height)
        if (!primed) {
          primed = true
          roW = w
          roH = h
          return
        }
        if (w === roW && h === roH) return
        roW = w
        roH = h
        scheduleRemeasure()
      })
      ro.observe(target.el)
    }

    // 画布只需要盖住顶部一条。
    // 一行只有 D > 0 时才有沙粒，也就是它的顶边必须已经越过消弥线；
    // 沙粒从行盒里飞出来，最远能飞到 spread 那么远，再加上 gravity 的向下偏置
    // 和 swirl 的侧向弧线，所以画布要盖到消弥线以下这么多。往上飞的会飞出
    // 屏幕顶（画布顶边就是视口顶边），自然被裁掉。
    // 整屏画布白算 6 倍面积，还会让合成器每帧重传一整屏纹理
    // （实测能掉到 40fps 并偶发 100ms 长帧）。
    let maxLineH = 0
    for (const ln of lines) maxLineH = Math.max(maxLineH, ln.bot - ln.top)
    const scatter = CFG.spread * (1 + Math.max(0, CFG.gravity)) + CFG.swirl + 12
    stripH = Math.min(
      window.innerHeight,
      Math.ceil(chromeBottom + maxLineH + scatter),
    )
    resizeCanvas()
  }

  function scheduleRemeasure() {
    clearTimeout(remeasureTimer)
    remeasureTimer = setTimeout(measure, 150)
  }

  /* ---------- 画布 ---------- */

  function resizeCanvas() {
    if (!stripH) stripH = Math.ceil(chromeBottom + 60)
    dpr = Math.min(2, window.devicePixelRatio || 1)
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(stripH * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = stripH + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------- mask ---------- */

  // 用 maskStep 高的硬台阶逼近 1 − t^curve 这条曲线，喂给 linear-gradient。
  // 每一段内部 alpha 恒定、段与段之间直接跳变，所以文字是一小条一小条地消失，
  // 而不是连续淡出——这就是"逐格碎开"的观感来源。
  // 台阶取段的下沿（靠消弥线那一端）的值，于是最靠下的那一段 alpha 正好是 1，
  // 贴着消弥线的字始终完整。
  // 位置全部换算成元素自身坐标；元素跟着页面滚，所以每帧要补 scrollY。
  function writeMask(sy) {
    if (!target) return
    const d = chromeBottom - (target.docTop - sy)
    if (d <= 0) {
      // 正文整个还在消弥线以下，不需要 mask
      if (lastMaskKey !== 'off') {
        lastMaskKey = 'off'
        target.el.style.maskImage = ''
        target.el.style.webkitMaskImage = ''
      }
      return
    }
    const ramp = chromeBottom
    const yStart = Math.max(0, d - ramp)
    const span = Math.max(1, d - yStart)
    const bands = Math.max(1, Math.round(span / CFG.maskStep))
    const stops = []
    for (let i = 0; i < bands; i++) {
      const y0 = Math.round(yStart + (span * i) / bands)
      const y1 = Math.round(yStart + (span * (i + 1)) / bands)
      const a = (1 - dissolveAt((d - y1) / ramp)).toFixed(3)
      // 同一段的首尾两个 stop 值相同 → 段内平坦；相邻段的边界处值跳变 → 硬边
      stops.push(`rgba(0,0,0,${a}) ${y0}px`)
      stops.push(`rgba(0,0,0,${a}) ${y1}px`)
    }
    stops.push('rgba(0,0,0,1) 100%')
    const v = `linear-gradient(to bottom, ${stops.join(', ')})`
    if (v === lastMaskKey) return
    lastMaskKey = v
    target.el.style.maskImage = v
    target.el.style.webkitMaskImage = v
  }

  /* ---------- 沙粒 ---------- */

  // 沙粒记的是「在本行里的相对位置」，不是屏幕坐标——
  // 这样行盒往上走时沙粒自动跟着走。
  // fx/fy 由格子下标算出来（格中心 + hash 抖动），不是纯随机，所以是钉在格点上的。
  // 散开方向、时序偏移那些随机量来自 grains.js，和首页开场共用同一套。
  function makePetal(ln, k) {
    const col = k % ln.cols
    const row = (k - col) / ln.cols
    const jx = hash2(col * 1.7 + row * 0.3, row * 9.1 + 4.2)
    const jy = hash2(col * 5.5 + row * 0.7, row * 2.9 + 8.3)
    return {
      fx: (col + 0.15 + jx * 0.7) / ln.cols,
      fy: (row + 0.15 + jy * 0.7) / ln.rows,
      ...makeGrain(col, row, ln.seed, CFG),
    }
  }

  // 逐格算凝聚进度。D 是行级消散度（0 贴着消弥线，1 屏幕最顶），
  // 每格再按自己的时序偏移 d 错开：
  //   tc = (D - d) / (1 - d)  —— 这一格的消散进度
  // d 越大越晚碎，所以靠近消弥线的格子先碎，越往顶越晚，参差感就是这么来的。
  // 沙粒用的是「凝聚进度」t = 1 − tc（grains.js 里 t=1 表示落在原位），
  // 于是字还完整时 t=1、沙粒根本不画；字碎干净时 t=0、沙粒全散开。
  function updateLines(sy) {
    const ramp = chromeBottom
    for (const ln of lines) {
      const lineY = ln.top - sy
      // 画布外整行的沙粒都不可能出现，跳过。已经滚到上面的行 D 恒为 1、
      // 沙粒停在 t=0，不更新也不会变；不跳的话每帧要空转几百行 × 上百格。
      if (lineY > stripH + 60 || ln.bot - sy < -60) continue
      const D = dissolveAt((chromeBottom - lineY) / ramp)
      if (D <= 0 && ln.grains.size === 0) continue
      const n = ln.cols * ln.rows
      for (let k = 0; k < n; k++) {
        const d = ln.ds[k]
        const tc = d >= 1 ? 1 : (D - d) / (1 - d)
        let g = ln.grains.get(k)
        if (tc > 0 && !g) {
          g = makePetal(ln, k)
          ln.grains.set(k, g)
        }
        if (!g) continue
        // t 存下来给 draw 用；散开时 t=0，字完整时 t=1（那时 alpha 已经淡到 0）
        g.t = 1 - (tc < 0 ? 0 : tc > 1 ? 1 : tc)
        if (g.t >= 0.9995) ln.grains.delete(k)
      }
    }
  }

  function draw(sy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const now = performance.now() / 1000
    for (const ln of lines) {
      if (ln.grains.size === 0) continue
      const lineY = ln.top - sy
      if (lineY > stripH + 60 || ln.bot - sy < -60) continue // 整行在画布外
      const w = ln.x1 - ln.x0
      const h = ln.bot - ln.top
      ctx.fillStyle = ln.color
      for (const g of ln.grains.values()) {
        const st = grainState(g, g.t, now, CFG)
        if (st.alpha <= 0.01) continue
        const x = ln.x0 + g.fx * w + st.dx
        const y = lineY + g.fy * h + st.dy
        if (x < -40 || x > W + 40 || y < -40 || y > stripH + 40) continue
        ctx.globalAlpha = st.alpha
        ctx.fillRect(x - st.size / 2, y - st.size / 2, st.size, st.size)
      }
    }
    ctx.globalAlpha = 1
  }

  /* ---------- 主循环 ---------- */

  // 有没有活干：视口附近还有沙粒在飞，或者有行正处在消散区间里。
  // 只算视口附近的行——已经滚到上面去的行，D 恒为 1、沙粒一直留着（这样往回滚
  // 时能直接凝聚回来），但它们不在画面上，不该让主循环一直空转。
  function busy(sy) {
    for (const ln of lines) {
      const y = ln.top - sy
      if (y > H + 80 || ln.bot - sy < -80) continue
      if (ln.grains.size) return true
      if (y < chromeBottom) return true
    }
    return false
  }

  function frame() {
    raf = requestAnimationFrame(frame)
    const sy = window.scrollY
    writeMask(sy)
    updateLines(sy)
    draw(sy)

    if (!busy(sy)) stop()
  }

  function start() {
    if (running) return
    running = true
    raf = requestAnimationFrame(frame)
  }

  function stop() {
    running = false
    cancelAnimationFrame(raf)
    raf = 0
  }

  const onScroll = () => {
    if (active) start()
  }

  /* ---------- 生命周期 ---------- */

  function enabled() {
    return !reduceMotion.matches && !narrow.matches
  }

  function enable() {
    active = true
    measure() // 里面会算 stripH 并 resizeCanvas
    start()
  }

  function disable() {
    active = false
    stop()
    lines = []
    if (target) {
      target.el.style.maskImage = ''
      target.el.style.webkitMaskImage = ''
    }
    lastMaskKey = ''
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  // 窗口尺寸变化、以及运行时切换「减弱动态效果」，都走这里
  function onResize() {
    if (!enabled()) {
      if (active) disable()
      return
    }
    if (!active) {
      enable()
      return
    }
    resizeCanvas()
    scheduleRemeasure()
  }

  function resync() {
    if (!enabled()) return
    measure()
    start()
  }

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)
  document.fonts?.ready.then(() => {
    if (enabled()) measure()
  })
  // 深浅色切换要重新测量：沙粒的颜色取自每行文字的计算色，换主题就变了
  themeObs = new MutationObserver(() => {
    if (enabled()) measure()
  })
  themeObs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })
  reduceMotion.addEventListener('change', onResize)
  narrow.addEventListener('change', onResize)

  if (enabled()) enable()

  return {
    resync,
    destroy() {
      disable()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      reduceMotion.removeEventListener('change', onResize)
      narrow.removeEventListener('change', onResize)
      themeObs?.disconnect()
      ro?.disconnect()
      clearTimeout(remeasureTimer)
    },
  }
}

let engine = null

onMounted(() => {
  engine = createEngine(canvasEl.value)
})

onBeforeUnmount(() => {
  engine?.destroy()
  engine = null
})

// VitePress 是 SPA 路由，正文容器会被整个换掉，必须重新测量
watch(
  () => route.path,
  async () => {
    await nextTick()
    engine?.resync()
  },
)
</script>

<template>
  <canvas ref="canvasEl" class="wiki-petals" aria-hidden="true" />
</template>
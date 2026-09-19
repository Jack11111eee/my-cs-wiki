<script setup>
/* 顶栏下方的「花瓣消散」。
   ---------------------------------------------------------------------------
   要解决的问题：顶栏是透明的，正文滚到它下面就会和导航链接糊在一起。
   以前靠顶栏自己的 backdrop-filter 把正文糊掉。现在改成：正文在顶栏这一带
   一点点散成花瓣，越往上散得越彻底，到屏幕最顶上完全散尽。

   消散线 = 顶栏底边。消弥梯度从这条线**往上**铺，正好铺满顶栏那 64px：
     刚碰到线的字     —— 还很清楚，只掉几片花瓣
     线往上走一半     —— 半消弥，字还在但明显在散
     屏幕最顶         —— 字没了，只剩花瓣云，再淡出
   所以静止时顶栏下方不会平白少一行，文字贴着顶栏底边也是完整的。

   花瓣是**挂在行盒上**的，不是钉在屏幕上：每片花瓣记的是「在本行里的相对位置」，
   每帧按行盒当前的位置算屏幕坐标。于是花瓣天然跟着文字一起往上走，
   就像文字本身变成了花瓣；往回滚时行的消散度降下来，花瓣就淡回去、文字重新凝聚。

   为什么用 mask 而不是把每个字包成 <span>：
   逐字包 span 能拿到最精确的碎裂效果，但会牵动拉丁文断行、::marker 列表序号、
   <a> 下划线、行内 code 底色、代码块底色，每个都得单独打补丁，而且动过 DOM
   之后将来开本地搜索会打坏它的高亮。mask 一次性把所有东西统一吃掉，且不动 DOM。
   花瓣位置改用 Range.getClientRects() 拿真实字符行盒，所以照样是从字上飞出来的。

   可访问性：prefers-reduced-motion 下整个不启动，由 custom.css 把顶栏的 blur 放回来。
   窄屏（<960px）不启用——顶栏在窄屏是不透明的，正文不会从它下面过。 */
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'

const canvasEl = ref(null)
const route = useRoute()

const CFG = {
  curve: 1.5, // 消散曲线指数。越大，越靠近消弥线的字越"扛得住"，越往顶散得越快
  density: 0.075, // 行宽每 1px、完全消散时的花瓣数（700px 的一行约 52 片，差不多一字一片）
  fadeIn: 0.16, // 花瓣淡入速度（每帧向目标靠拢的比例）
  fadeOut: 0.1, // 淡出速度
  swayAmp: 2.5, // 左右轻微飘动幅度（px）
  spin: 0.35, // 自转角速度（rad/s）
  maxPerLine: 140, // 单行花瓣上限，防止超长行炸掉
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
  let stripH = 0 // 画布高度：花瓣只可能出现在顶部这一条，见 measure()
  let target = null // { el, docTop }  正文容器，只会有一个
  let lines = [] // [{ x0,x1,top,bot, petals:[], live }]  行盒，文档坐标
  let chromeBottom = 64
  let sprites = []
  let sizeScale = 1
  let raf = 0
  let running = false // 主循环在跑
  let active = false // 效果处于启用状态（可能正闲着没在跑循环）
  let lastMaskKey = ''
  let remeasureTimer = 0
  let ro = null
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

  // 行盒只在这里读一次，之后每帧纯算术
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
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode)
      const rects = range.getClientRects()
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue
        lines.push({
          x0: r.left,
          x1: r.right,
          top: r.top + sy,
          bot: r.bottom + sy,
          petals: [],
          live: 0,
        })
      }
    }
  }

  function measure() {
    const sy = window.scrollY
    chromeBottom = readChromeBottom()
    // 正文页是 .vp-doc，首页是 .VPHome，两者只会存在一个
    const el = document.querySelector('.VPDoc .vp-doc') || document.querySelector('.VPHome')
    target = el ? { el, docTop: el.getBoundingClientRect().top + sy } : null
    lines = []
    if (target) collectLines(target.el, sy)
    lastMaskKey = ''
    if (ro) ro.disconnect()
    if (target) {
      ro = new ResizeObserver(scheduleRemeasure)
      ro.observe(target.el)
    }

    // 画布只需要盖住顶部一条。
    // 一行只有 D > 0 时才有花瓣，也就是它的顶边必须已经越过消弥线；
    // 花瓣的 y 又在 [行顶, 行底] 之间，所以花瓣不可能跑到
    // chromeBottom + 最高的行高 以下。整屏画布白算 6 倍面积，还会让
    // 合成器每帧重传一整屏纹理（实测能掉到 40fps 并偶发 100ms 长帧）。
    let maxLineH = 0
    for (const ln of lines) maxLineH = Math.max(maxLineH, ln.bot - ln.top)
    stripH = Math.min(window.innerHeight, Math.ceil(chromeBottom + maxLineH + 12))
    resizeCanvas()
  }

  function scheduleRemeasure() {
    clearTimeout(remeasureTimer)
    remeasureTimer = setTimeout(measure, 150)
  }

  /* ---------- 花瓣贴图 ---------- */

  // 单瓣樱花：底部收窄、尖端有个 V 形缺口
  function petalSprite(size, c0, c1, c2) {
    const c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')
    const w = size * 0.62
    const h = size * 0.92
    g.translate(size / 2, size / 2)
    g.beginPath()
    g.moveTo(0, h * 0.5)
    g.bezierCurveTo(w * 0.62, h * 0.3, w * 0.56, -h * 0.3, w * 0.15, -h * 0.5)
    g.lineTo(0, -h * 0.32) // 缺口
    g.lineTo(-w * 0.15, -h * 0.5)
    g.bezierCurveTo(-w * 0.56, -h * 0.3, -w * 0.62, h * 0.3, 0, h * 0.5)
    g.closePath()
    const grad = g.createLinearGradient(0, h * 0.5, 0, -h * 0.5)
    grad.addColorStop(0, c0)
    grad.addColorStop(0.55, c1)
    grad.addColorStop(1, c2)
    g.fillStyle = grad
    g.fill()
    return c
  }

  // 六角冰晶
  function snowSprite(size, c0, c1) {
    const c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')
    const r = size * 0.42
    g.translate(size / 2, size / 2)
    g.strokeStyle = c0
    g.lineWidth = Math.max(1, size * 0.075)
    g.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      g.save()
      g.rotate((i * Math.PI) / 3)
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(0, -r)
      for (const t of [0.5, 0.78]) {
        const y = -r * t
        const len = r * (1 - t) * 0.75
        g.moveTo(0, y)
        g.lineTo(len * 0.8, y - len * 0.5)
        g.moveTo(0, y)
        g.lineTo(-len * 0.8, y - len * 0.5)
      }
      g.stroke()
      g.restore()
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.5)
    core.addColorStop(0, c1)
    core.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = core
    g.beginPath()
    g.arc(0, 0, r * 0.5, 0, Math.PI * 2)
    g.fill()
    return c
  }

  function buildSprites() {
    const css = getComputedStyle(document.documentElement)
    const v = (n) => css.getPropertyValue(n).trim()
    const dark = document.documentElement.classList.contains('dark')
    const S = 34
    if (dark) {
      const a = v('--wiki-petal-a') || '#9fc2f0'
      const b = v('--wiki-petal-b') || '#cfe0ff'
      const c = v('--wiki-petal-c') || '#ffffff'
      sprites = [snowSprite(S, b, c), snowSprite(S, a, c), snowSprite(S, c, c)]
      // 冰晶的六条臂铺满整张贴图，花瓣只占贴图中间一条，
      // 同样尺寸下冰晶看着要大一圈，所以夜里整体缩一档
      sizeScale = 0.8
    } else {
      const a = v('--wiki-petal-a') || '#ef9dbb'
      const b = v('--wiki-petal-b') || '#f8c9dc'
      const c = v('--wiki-petal-c') || '#fff2f7'
      sprites = [
        petalSprite(S, a, b, c),
        petalSprite(S, b, c, c),
        petalSprite(S, c, b, c),
        petalSprite(S, a, c, b),
      ]
      sizeScale = 1
    }
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

  // 用 8 段折线逼近 1 − t^curve 这条曲线，喂给 linear-gradient。
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
    const N = 8
    const stops = []
    // i 从 N 到 0：本地 y 递增，正好是 linear-gradient 要求的顺序
    for (let i = N; i >= 0; i--) {
      const t = i / N
      const y = Math.max(0, Math.round(d - t * ramp))
      stops.push(`rgba(0,0,0,${(1 - dissolveAt(t)).toFixed(3)}) ${y}px`)
    }
    stops.push('rgba(0,0,0,1) 100%')
    const v = `linear-gradient(to bottom, ${stops.join(', ')})`
    if (v === lastMaskKey) return
    lastMaskKey = v
    target.el.style.maskImage = v
    target.el.style.webkitMaskImage = v
  }

  /* ---------- 花瓣 ---------- */

  // 花瓣记的是「在本行里的相对位置」，不是屏幕坐标——
  // 这样行盒往上走时花瓣自动跟着走。
  function makePetal() {
    return {
      fx: Math.random(), // 行内横向 0..1
      fy: 0.15 + Math.random() * 0.85, // 行内纵向 0..1
      sp: sprites.length ? (Math.random() * sprites.length) | 0 : 0, // 贴图编号
      s: (4.5 + Math.random() * 5.5) * sizeScale,
      rot: Math.random() * Math.PI * 2,
      dir: Math.random() < 0.5 ? -1 : 1,
      sw: 0.5 + Math.random() * 1.1, // 左右摆动频率
      swp: Math.random() * Math.PI * 2,
      flip: 0.6 + Math.random() * 1.6, // 翻转频率
      fp: Math.random() * Math.PI * 2,
      base: 0.6 + Math.random() * 0.4, // 每片透明度略有差异
      a: 0,
    }
  }

  function updateLines(sy) {
    const ramp = chromeBottom
    for (const ln of lines) {
      const t = (chromeBottom - (ln.top - sy)) / ramp
      const D = dissolveAt(t)
      const want = D > 0
        ? Math.min(CFG.maxPerLine, Math.round(D * (ln.x1 - ln.x0) * CFG.density))
        : 0

      while (ln.petals.length < want) ln.petals.push(makePetal())
      ln.live = want

      for (let i = 0; i < ln.petals.length; i++) {
        const p = ln.petals[i]
        const goal = i < want ? 1 : 0
        p.a += (goal - p.a) * (goal > p.a ? CFG.fadeIn : CFG.fadeOut)
      }
      // 尾巴上已经淡透的收掉（want 之后的全在尾巴上，所以从后往前弹是安全的）
      while (ln.petals.length > want && ln.petals[ln.petals.length - 1].a < 0.005) {
        ln.petals.pop()
      }
    }
  }

  function draw(sy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const t = performance.now() / 1000
    for (const ln of lines) {
      if (!ln.petals.length) continue
      const lineY = ln.top - sy
      const h = ln.bot - ln.top
      if (lineY > stripH + 40 || lineY + h < -40) continue // 整行在画布外
      const w = ln.x1 - ln.x0
      for (const p of ln.petals) {
        if (p.a < 0.01) continue
        const x = ln.x0 + p.fx * w + Math.sin(t * p.sw + p.swp) * CFG.swayAmp
        const y = lineY + p.fy * h
        ctx.globalAlpha = p.a * p.base
        ctx.translate(x, y)
        ctx.rotate(p.rot + t * CFG.spin * p.dir)
        // 用纵向压缩模拟花瓣轻微翻转
        ctx.scale(1, Math.cos(t * p.flip + p.fp) * 0.6 + 0.4)
        ctx.drawImage(sprites[p.sp], -p.s, -p.s, p.s * 2, p.s * 2)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    ctx.globalAlpha = 1
  }

  /* ---------- 主循环 ---------- */

  // 有没有活干：视口附近还有花瓣在淡出，或者有行正处在消散区间里。
  // 只算视口附近的行——已经滚到上面去的行，D 恒为 1、花瓣一直留着（这样往回滚
  // 时能直接凝聚回来），但它们不在画面上，不该让主循环一直空转。
  function busy(sy) {
    for (const ln of lines) {
      const y = ln.top - sy
      if (y > H + 80 || ln.bot - sy < -80) continue
      if (ln.petals.length) return true
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
    buildSprites()
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
  // 深浅色切换要重建贴图
  themeObs = new MutationObserver(() => {
    if (enabled()) buildSprites()
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
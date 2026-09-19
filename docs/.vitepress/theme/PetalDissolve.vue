<script setup>
/* 顶栏下方的「花瓣消散」。
   ---------------------------------------------------------------------------
   要解决的问题：顶栏是透明的，正文滚到它下面就会和导航链接糊在一起。
   以前靠顶栏自己的 backdrop-filter 把正文糊掉（custom.css 里那段注释）。
   现在改成：正文在进入顶栏之前就消散掉，并在这个边界上炸出花瓣。

   为什么用 mask 而不是把每个字包成 <span>：
   逐字包 span 能拿到最精确的碎裂效果，但会牵动一堆东西——拉丁文断行、
   ::marker 列表序号、<a> 下划线、行内 code 底色、代码块底色，每个都得单独打补丁，
   而且动过 DOM 之后 VitePress 将来开本地搜索会打坏它的高亮。
   mask 是一次性把所有东西（字、序号、下划线、底色、图片）统一吃掉，且完全不动 DOM。
   花瓣位置改用 Range.getClientRects() 拿真实字符行盒，所以花瓣照样是从字上飞出来的。

   三层结构：
     1. mask      —— 挂在正文容器上，位置每帧按 scrollY 重算，钉死在顶栏底边。
                     渐隐带宽 = f(滚动速度)：静止收窄到 8px（顶栏底下那点反正看不见），
                     滚得越快带越宽（上限 48px）。滚得越猛，字被啃得越狠。
     2. 花瓣       —— 独立 canvas（z-index 26：压过内容 4 和侧栏 25，在顶栏 30 之下）。
     3. 性能       —— 行盒在 measure() 时一次性算成文档坐标缓存下来，每帧只做减法，
                     不碰 getBoundingClientRect，不触发 layout。

   可访问性：prefers-reduced-motion 下整个不启动，由 custom.css 把顶栏的 blur 放回来。
   窄屏（<960px）不启用——顶栏在窄屏是不透明的，正文不会从它下面过。 */
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'

const canvasEl = ref(null)
const route = useRoute()

/* 数值都按「视口 px / 秒」调 */
const CFG = {
  bandMin: 8, // 静止时的柔边宽度
  bandMax: 48, // 最快时的消散带宽度
  bandPerSpeed: 0.055, // 带宽 = 速度 × 这个系数
  bandEase: 0.2, // 带宽变化的平滑系数
  maxPetals: 240, // 同屏花瓣上限
  maxEmitPerFrame: 14, // 每帧最多补几片，防止快速滚动时炸开
  gravity: 95,
  drag: 1.1,
}

function createEngine(canvas) {
  const ctx = canvas.getContext('2d')
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const narrow = matchMedia('(max-width: 959px)')

  let dpr = 1
  let W = 0
  let H = 0
  let target = null // { el, docTop }  正文容器，只会有一个
  let nodes = [] // [{ lines:[{x0,x1,top,bot}], emitted }]  文档坐标
  let chromeBottom = 64
  let sprites = []
  let sizeScale = 1
  let petals = []
  let raf = 0
  let running = false // 主循环在跑
  let active = false // 效果处于启用状态（可能正闲着没在跑循环）
  let lastT = 0
  let lastScrollY = window.scrollY
  let smoothVel = 0 // px/s，正数 = 向下滚
  let band = CFG.bandMin
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
      const lines = []
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue
        lines.push({ x0: r.left, x1: r.right, top: r.top + sy, bot: r.bottom + sy })
      }
      if (!lines.length) continue
      // 首次测量时把已经在顶栏底下的行标记为「已发射」，避免加载瞬间喷一屏花瓣
      const rest = chromeBottom + CFG.bandMin
      let emitted = 0
      while (emitted < lines.length && lines[emitted].top - sy < rest) emitted++
      nodes.push({ lines, emitted })
    }
  }

  function measure() {
    const sy = window.scrollY
    chromeBottom = readChromeBottom()
    // 正文页是 .vp-doc，首页是 .VPHome，两者只会存在一个
    const el = document.querySelector('.VPDoc .vp-doc') || document.querySelector('.VPHome')
    target = el ? { el, docTop: el.getBoundingClientRect().top + sy } : null
    nodes = []
    if (target) collectLines(target.el, sy)
    lastMaskKey = ''
    if (ro) ro.disconnect()
    if (target) {
      ro = new ResizeObserver(scheduleRemeasure)
      ro.observe(target.el)
    }
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
      // 两侧的分叉
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
      sizeScale = 0.6
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
    dpr = Math.min(2, window.devicePixelRatio || 1)
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------- mask ---------- */

  function writeMask(sy) {
    if (!target) return
    const b = Math.max(2, Math.round(band))
    // d = 顶栏底边在元素自身坐标系里的位置。元素跟着页面滚，所以每帧要补 scrollY。
    const d = Math.round(chromeBottom - (target.docTop - sy))
    const key = d + ':' + b
    if (key === lastMaskKey) return
    lastMaskKey = key
    const v = `linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) ${d}px, rgba(0,0,0,1) ${d + b}px, rgba(0,0,0,1) 100%)`
    target.el.style.maskImage = v
    target.el.style.webkitMaskImage = v
  }

  /* ---------- 花瓣 ---------- */

  function push(x, y, carry) {
    if (petals.length >= CFG.maxPetals) petals.shift()
    const a = Math.random() * Math.PI * 2
    const burst = 20 + Math.random() * 70
    petals.push({
      x,
      y,
      vx: Math.cos(a) * burst * 0.8,
      // 顺滚动方向被带走（carry 已经取过反号），再叠一点上抛
      vy: Math.sin(a) * burst * 0.55 + carry * 0.45 - 30,
      s: (5 + Math.random() * 6) * sizeScale,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 5,
      flip: 0.8 + Math.random() * 2.4,
      flipPhase: Math.random() * Math.PI * 2,
      sway: 1.2 + Math.random() * 2.2,
      swayPhase: Math.random() * Math.PI * 2,
      swayAmp: 14 + Math.random() * 26,
      life: 0,
      maxLife: 1.1 + Math.random() * 1.0,
      sprite: sprites[(Math.random() * sprites.length) | 0],
    })
  }

  function spawn(lines, sy, carry) {
    let budget = CFG.maxEmitPerFrame
    for (const ln of lines) {
      const w = ln.x1 - ln.x0
      if (w < 1) continue
      const count = Math.max(2, Math.min(9, Math.round(w / 26)))
      for (let i = 0; i < count && budget > 0; i++, budget--) {
        push(
          ln.x0 + Math.random() * w,
          ln.top - sy + Math.random() * (ln.bot - ln.top),
          carry,
        )
      }
    }
  }

  function draw(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const t = performance.now() / 1000
    for (let i = petals.length - 1; i >= 0; i--) {
      const p = petals[i]
      p.life += dt
      if (p.life >= p.maxLife) {
        petals.splice(i, 1)
        continue
      }
      p.vy += CFG.gravity * dt
      const k = Math.exp(-CFG.drag * dt)
      p.vx *= k
      p.vy *= k
      p.x += (p.vx + Math.sin(t * p.sway + p.swayPhase) * p.swayAmp) * dt
      p.y += p.vy * dt
      p.rot += p.vrot * dt
      const u = p.life / p.maxLife
      const alpha = u < 0.12 ? u / 0.12 : u > 0.55 ? 1 - (u - 0.55) / 0.45 : 1
      ctx.globalAlpha = Math.max(0, alpha) * 0.95
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      // 用横向压缩模拟花瓣翻转
      ctx.scale(Math.cos(t * p.flip + p.flipPhase) * 0.75 + 0.25, 1)
      ctx.drawImage(p.sprite, -p.s, -p.s, p.s * 2, p.s * 2)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    ctx.globalAlpha = 1
  }

  /* ---------- 主循环 ---------- */

  function frame(now) {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.033, (now - lastT) / 1000 || 0.016)
    lastT = now

    const sy = window.scrollY
    const dy = sy - lastScrollY
    lastScrollY = sy
    smoothVel += (dy / dt - smoothVel) * 0.25
    const speed = Math.abs(smoothVel)

    const targetBand = Math.min(
      CFG.bandMax,
      Math.max(CFG.bandMin, speed * CFG.bandPerSpeed),
    )
    band += (targetBand - band) * CFG.bandEase

    // 先读（全是算术），后写，中间不夹 style 写入
    const eatY = chromeBottom + band
    const restY = chromeBottom + CFG.bandMin
    const emit = []
    for (const n of nodes) {
      let hi = 0
      while (hi < n.lines.length && n.lines[hi].top - sy < eatY) hi++
      if (hi > n.emitted) {
        for (let i = n.emitted; i < hi; i++) emit.push(n.lines[i])
        n.emitted = hi
      } else if (hi < n.emitted) {
        // 往回滚时把游标退回来，但要退回柔边之外，否则边界上会反复补花瓣
        let lo = 0
        while (lo < n.lines.length && n.lines[lo].top - sy < restY) lo++
        if (lo < n.emitted) n.emitted = lo
      }
    }

    if (emit.length && sprites.length) {
      spawn(emit, sy, Math.max(-420, Math.min(420, -smoothVel * 0.5)))
    }

    writeMask(sy)
    draw(dt)

    if (!petals.length && band <= CFG.bandMin + 0.5 && speed < 6) stop()
  }

  function start() {
    if (running) return
    running = true
    lastT = performance.now()
    lastScrollY = window.scrollY
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
    resizeCanvas()
    measure()
    buildSprites()
    start()
  }

  function disable() {
    active = false
    stop()
    petals = []
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
      stop()
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
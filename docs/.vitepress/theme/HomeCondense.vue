<script setup>
/* 首页开场的「沙粒凝聚」。
   ---------------------------------------------------------------------------
   首页整页只有 ~543px 高（hero 376 + 三张卡片 ~103 + 下边距 128），在常见桌面
   视口里根本滚不动。所以 canvasui particle-scroll 那种「形成线随滚动推进」
   在这里无从谈起——没有滚动可以驱动它。
   改成：进入首页时，整页内容从上往下逐行从沙粒里凝聚一次，约 1.2s，之后静止。

   沙粒的算法照搬 canvasui particle-scroll 的顶点着色器（POINT_VERT）：
     d = hash(cell) * stagger         每粒沙的时序偏移
     p = (elapsed − 这一行的延迟) / settle   这一行的凝聚进度
     t = clamp((p − d) / (1 − d))     这一粒沙的凝聚进度
     e = 1 − (1 − t)³                 缓出
     pos = mix(散开位, 原位, e)        从散开位插值回原位
   再加上侧向弧线（swirl）、未落地时的正弦漂浮（drift）、落地前的抖动，以及尺寸
   和透明度随 e 变化——落地时变大变实，所以看着像「沙落回原处」。

   和原版的关键差异：原版粒子采样的是被 drawElementImage 捕获的内容纹理，每粒沙
   带着它原来那个像素的颜色。我们拿不到像素（那需要实验性的 html-in-canvas API，
   见 canvasui 的安装文档），所以改用「行盒裁剪 + 该行文字的计算色」。正文基本
   单色，观感损失很小；代价是图片/彩色内容做不到像素级。「沙粒逐粒拼成笔画」
   这个细节也模拟不出来，所以文字的真实显形仍然交给 mask，沙粒只负责消散区的
   颗粒感（和 PetalDissolve.vue 同一套思路）。

   可访问性：prefers-reduced-motion 下整个不启动，内容直接完整显示。 */
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'

const canvasEl = ref(null)
const route = useRoute()

const CFG = {
  density: 6, // 格点边长（px）。越小沙越细，但沙粒总数会平方级涨
  size: 1.4, // 完全散开时沙粒的边长（px）
  spread: 150, // 最大飞散距离（px）
  gravity: 0.35, // 向下偏置，像沙往下沉。负值会往上飘
  drift: 0.7, // 漂浮速度。0 冻住
  swirl: 45, // 侧向弧线幅度（px）
  stagger: 0.7, // 每粒沙时序的参差程度。0 一起落，1 最参差
  fade: 0.85, // 完全散开时的不透明度
  settle: 0.55, // 单粒沙从散开到落位耗时（秒）
  speed: 520, // 凝聚波往下推进的速度（px/s）
  grow: 0.45, // 落地时沙粒边长相对格点边长的比例。
  // 这里故意比 canvasui 小：原版让沙粒长到 1.3 倍格点、盖满自己的格子，
  // 因为它采样了真实内容像素，沙粒拼起来就是无缝的文字。
  // 我们拿不到像素，涨到盖满只会把行盒变成一个实心色块，所以只长大一点点。
  maxGrains: 14000, // 沙粒总数上限，兜底防止超长页面炸掉
}

// 和 canvasui 的 GLSL hash 同款：fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)。
// 用它而不是 Math.random()，是为了让每粒沙的散开方向只由它的格点决定——
// 同一粒每帧算出来都一样，否则沙会在原地乱抖。
function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function createEngine(canvas) {
  const ctx = canvas.getContext('2d')
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

  let dpr = 1
  let W = 0
  let H = 0
  let target = null // .VPHome
  let homeH = 0 // .VPHome 的高度（mask 的坐标系）
  let grains = [] // 按颜色排好序，draw 时只在换色那一下改 fillStyle
  let y0 = 0 // 第一行文字的 y（相对 .VPHome），凝聚波的起点
  let endAt = 0 // 全部落位所需秒数
  let startAt = 0 // 本轮动画的起点
  let raf = 0
  let running = false // 主循环在跑
  let active = false // 效果处于启用状态
  let lastMaskKey = ''
  let remeasureTimer = 0
  let ro = null

  /* ---------- 测量 ---------- */

  function measure() {
    target = document.querySelector('.VPHome')
    grains = []
    y0 = 0
    endAt = 0
    lastMaskKey = ''
    if (ro) ro.disconnect()

    if (!target) {
      homeH = 0
      releaseCanvas()
      return
    }

    homeH = target.offsetHeight
    const box = target.getBoundingClientRect()

    // 行盒 + 每行的文字色。规则与 PetalDissolve.vue 一致：
    // 标题后面那个 # 锚点、给读屏用的隐藏文字都不参与。
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const p = n.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        if (p.closest('.header-anchor, .visually-hidden, script, style'))
          return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const range = document.createRange()
    const lines = []
    while (walker.nextNode()) {
      const color = getComputedStyle(walker.currentNode.parentElement).color
      range.selectNodeContents(walker.currentNode)
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue
        lines.push({
          x: r.left - box.left,
          y: r.top - box.top,
          w: r.width,
          h: r.height,
          color,
        })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    if (!lines.length) {
      releaseCanvas()
      return
    }
    y0 = lines[0].y

    // 铺沙：每行按 density 切格，一格一粒
    const D = CFG.density
    let maxY = y0
    for (let li = 0; li < lines.length && grains.length < CFG.maxGrains; li++) {
      const ln = lines[li]
      const cols = Math.max(1, Math.ceil(ln.w / D))
      const rows = Math.max(1, Math.ceil(ln.h / D))
      maxY = Math.max(maxY, ln.y + ln.h)
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          if (grains.length >= CFG.maxGrains) break
          const h1 = hash2(col * 1.3 + li * 0.37, row * 2.1 + li * 0.11)
          const h2 = hash2(col * 4.7 + li * 0.53, row * 1.9 + li * 0.29)
          const h3 = hash2(col * 2.3 + li * 0.71, row * 5.3 + li * 0.43)
          const h4 = hash2(col * 3.1 + li * 0.17, row * 7.7 + li * 0.61)
          const ang = h2 * Math.PI * 2
          const dx = Math.cos(ang)
          const dy = Math.sin(ang)
          // reach 让大多数沙落在附近、少数飞得很远，云才有厚薄
          const reach = 0.08 + 0.92 * Math.pow(h4, 2.4)
          grains.push({
            x: ln.x + (col + 0.5) * (ln.w / cols),
            y: ln.y + (row + 0.5) * (ln.h / rows),
            color: ln.color,
            d: h1 * CFG.stagger,
            offx: dx * CFG.spread * reach,
            offy: dy * CFG.spread * reach + CFG.gravity * CFG.spread * (0.25 + 0.75 * h4),
            px: -dy, // 与飞散方向垂直，用来做侧向弧线
            py: dx,
            f1: 4 + 5 * h2, // 漂浮的两个频率与相位
            f2: 3.5 + 5.5 * h3,
            p1: h3 * 40,
            p2: h2 * 40,
            jx: (h4 - 0.5) * D * 3, // 落地前的抖动
            jy: (h1 - 0.5) * D * 3,
          })
        }
      }
    }
    // 按颜色排好，draw 时只在颜色变化那一下写 fillStyle
    grains.sort((a, b) => (a.color < b.color ? -1 : a.color > b.color ? 1 : 0))

    endAt = (maxY - y0) / CFG.speed + CFG.settle
    resizeCanvas()
    ro = new ResizeObserver(scheduleRemeasure)
    ro.observe(target)
  }

  function scheduleRemeasure() {
    clearTimeout(remeasureTimer)
    remeasureTimer = setTimeout(() => {
      measure()
      // 动画还没跑完就重测的话，时间轴接着走，不重播
      if (active && running) return
      if (active) finish()
    }, 150)
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

  // 不在首页时把画布缩到 1×1。整屏画布在 dpr 2 下是 20MB 量级的缓冲，
  // 文档页上这块画布永远不会被画，没必要一直占着。
  function releaseCanvas() {
    canvas.width = 1
    canvas.height = 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, 1, 1)
  }

  /* ---------- 单粒沙 ---------- */

  // 这一粒沙的凝聚进度。行级进度 p 由「它在页面里的高度」决定，
  // 再叠上它自己的时序偏移 d —— 越靠下的行开始得越晚，行内各粒再错开。
  function grainT(g, elapsed) {
    const p = (elapsed - (g.y - y0) / CFG.speed) / CFG.settle
    if (p <= 0) return 0
    if (p >= 1) return 1
    const d = g.d
    const t = d >= 1 ? 1 : (p - d) / (1 - d)
    return t < 0 ? 0 : t > 1 ? 1 : t
  }

  function draw(elapsed) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!target) return
    const topV = target.getBoundingClientRect().top // 元素顶边此刻在视口里的位置
    const tt = (performance.now() / 1000) * CFG.drift
    const driftAmp = CFG.spread * 0.05 + 2.5
    const sizeEnd = CFG.density * CFG.grow
    let lastColor = ''

    for (const g of grains) {
      const t = grainT(g, elapsed)
      if (t >= 0.9995) continue // 已经完全落位，交给 mask 里的真实文字
      const e = 1 - Math.pow(1 - t, 3)

      const hx = g.x
      const hy = g.y + topV
      const scx = hx + g.offx
      const scy = hy + g.offy
      let x = scx + (hx - scx) * e
      let y = scy + (hy - scy) * e

      const arc = Math.sin(e * Math.PI) * CFG.swirl
      x += g.px * arc
      y += g.py * arc

      const amp = (1 - e) * driftAmp
      x += Math.sin(tt * g.f1 + g.p1) * amp
      y += Math.cos(tt * g.f2 + g.p2) * amp

      const jit = 1 - smoothstep(0.5, 0.85, t)
      x += g.jx * jit
      y += g.jy * jit

      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue

      const size = CFG.size + (sizeEnd - CFG.size) * smoothstep(0.55, 1, e)
      // 落地前淡出。原版是靠沙粒长到盖满格子、真实内容无缝接管，
      // 我们拿不到内容像素，所以改成淡出，避免最后一帧"啪"地跳一下。
      const a = (CFG.fade + (1 - CFG.fade) * e) * (1 - smoothstep(0.9, 0.9995, t))
      if (a <= 0.01) continue

      if (g.color !== lastColor) {
        ctx.fillStyle = g.color
        lastColor = g.color
      }
      ctx.globalAlpha = a
      ctx.fillRect(x - size / 2, y - size / 2, size, size)
    }
    ctx.globalAlpha = 1
  }

  /* ---------- mask ---------- */

  // 一条软边带，随时间从上往下扫。带子扫过之前内容完全不显形——
  // 文字的显形由它负责，沙粒只叠在上面做颗粒感。
  // 带子比沙粒滞后一点（settle 的 0.2~0.7 倍），让沙先飞一会儿、字再透出来。
  function writeMask(elapsed) {
    if (!target || !homeH) return
    const yFull = y0 + (elapsed - CFG.settle * 0.7) * CFG.speed
    if (yFull >= homeH) {
      if (lastMaskKey !== 'off') {
        lastMaskKey = 'off'
        target.style.maskImage = ''
        target.style.webkitMaskImage = ''
      }
      return
    }
    const yZero = Math.max(
      yFull,
      Math.min(homeH, y0 + (elapsed - CFG.settle * 0.2) * CFG.speed),
    )
    const v = `linear-gradient(to bottom, rgba(0,0,0,1) ${yFull.toFixed(1)}px, rgba(0,0,0,0) ${yZero.toFixed(1)}px)`
    if (v === lastMaskKey) return
    lastMaskKey = v
    target.style.maskImage = v
    target.style.webkitMaskImage = v
  }

  /* ---------- 主循环 ---------- */

  function frame() {
    raf = requestAnimationFrame(frame)
    const elapsed = (performance.now() - startAt) / 1000
    writeMask(elapsed)
    draw(elapsed)
    if (elapsed > endAt + 0.15) finish()
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

  // 动画跑完（或被打断）：撤掉 mask、清空画布，但留着 target 和 grains，
  // 这样窗口缩放重测时还能接着用。
  function finish() {
    stop()
    if (target) {
      target.style.maskImage = ''
      target.style.webkitMaskImage = ''
    }
    lastMaskKey = 'off'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  /* ---------- 生命周期 ---------- */

  function enabled() {
    return !reduceMotion.matches
  }

  function enable() {
    measure()
    if (!target || !grains.length) {
      active = false
      return
    }
    active = true
    startAt = performance.now()
    start()
  }

  function disable() {
    active = false
    stop()
    finish()
    grains = []
    target = null
    homeH = 0
    lastMaskKey = ''
  }

  // 换页、字体就绪、运行时切换「减弱动态效果」都走这里
  function resync() {
    disable()
    if (enabled()) enable()
  }

  function onResize() {
    if (!enabled()) {
      disable()
      return
    }
    if (!active) {
      enable()
      return
    }
    resizeCanvas()
    scheduleRemeasure()
  }

  reduceMotion.addEventListener('change', onResize)

  return {
    resync,
    // 字体到位后把沙粒的家位置就地校正一次。
    // 不能在挂载时 await document.fonts.ready 再开始——那样首屏会先完整渲染出来，
    // 等字体（4G 降速下要 1s 以上）才"啪"地变成沙，中间那一大段闪烁很难看。
    // 所以挂载就开跑，字体到了再量一次；此时沙粒多半还在半空，
    // 家位置挪一点几乎看不出来（pos = mix(散开位, 原位, e)，e 小的时候本来就远离原位）。
    reflow() {
      if (active) measure()
    },
    destroy() {
      disable()
      reduceMotion.removeEventListener('change', onResize)
      ro?.disconnect()
      clearTimeout(remeasureTimer)
    },
  }
}

let engine = null

onMounted(() => {
  engine = createEngine(canvasEl.value)
  engine.resync()
  // 自托管字体是 swap 的，挂载时量到的是回退字体的行盒。字体到位后补量一次，
  // 把沙粒挪到正确的位置。见下面 reflow 的注释。
  document.fonts?.ready.then(() => engine?.reflow())
})

onBeforeUnmount(() => {
  engine?.destroy()
  engine = null
})

// VitePress 是 SPA 路由，首页容器会被整个换掉，必须重新测量
watch(
  () => route.path,
  async () => {
    await nextTick()
    engine?.resync()
  },
)
</script>

<template>
  <canvas ref="canvasEl" class="wiki-condense" aria-hidden="true" />
</template>
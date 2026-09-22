<script setup>
/* 全屏落樱 / 落雪。
   ---------------------------------------------------------------------------
   白天落花瓣、夜里落雪，铺在底图（.wiki-bg，z-index 1）和磨砂玻璃（.wiki-glass，
   z-index 3）之间，也就是 z-index 2。压在玻璃之下，所以花瓣是被玻璃洗淡的柔光，
   像窗外落樱，不会盖到正文上。

   **为什么把模糊从玻璃挪到了底图（这一步是本组件的前置条件，不是顺带的优化）**
   玻璃原来是 backdrop-filter: blur(10px)。粒子层一旦插在它下面，粒子每帧一动就把
   玻璃的采样源标脏，整屏模糊一秒重算几十次——实测「模糊 + 动画」叠一起是 GPU 99% 忙、
   18% 掉帧，而单独任一半只有 20% / 25%（来源见 design-refs/falling-fx/SPEC.md 第 1 节）。
   挪成底图自己的 filter 之后，模糊算一次就缓存住。
   代价是花瓣不再被真高斯糊过，柔度得自己造，见下面 bake()。
   视觉等价性在正式站点上复验过，见 SPEC.md 第 2 节与本次上线的截图比对。

   **深度模型**
   每粒粒子带一个深度值 z，靠三件事一起传达近大远小：
     s  = 1 + z * scaleK      尺度
     vy = 基准落速 * s         落速（**视差感主要靠这个**，只有尺寸差会看成「有些花瓣本来就大」）
     a  = aFar + (aNear-aFar)*z 透明度
   z 采样偏向远景（z = pow(u, 3)，近景只占 ~9%），因为面积按 s² 涨，
   均匀采样会让面积密度严重偏向近景——恰好是伤阅读的那批。再叠一道近景全屏硬上限。

   **柔度烘进精灵**：图集里每档柔边用 ctx.filter 预先糊一次，运行时按粒子的深度挑档位，
   于是「远的更糊、近的更实」是真的，比统一糊多一层景深线索。
   浏览器没有 canvas 的 ctx.filter 时退化成多次微偏移叠画。

   可访问性：prefers-reduced-motion 下整个不启动；窄屏（<960px）不启用，
   跟 PetalDissolve.vue / HomeCondense.vue 的约定一致。 */
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvasEl = ref(null)

const CFG = {
  // 深度
  zPow: 3,        // z = pow(u, zPow)：越大，粒子越挤在远景
  scaleK: 1.6,    // 尺度 s = 1 + z * scaleK，最近 ≈ 2.6×
  nearZ: 0.75,    // 超过它算「近景」
  nearCap: 10,    // 近景全屏上限
  // 尺寸（s = 1 时的 CSS px）
  petalSize: 10,
  snowSize: 4.2,
  // 落速（s = 1 时的 px/s）
  petalFall: 26,
  snowFall: 34,
  // 透明度：远景淡、近景实，但整条都要扛得住玻璃那层 68% 的洗白。
  // 隔着玻璃的可见度 ≈ alpha × 0.32，所以这组值看着比实际大不少。
  aFar: 0.30,
  aNear: 0.85,
  // 数量：按面积归一化到 1920×1080，免得 4K 屏拿到 8 倍负载
  density: 140,
  maxCount: 200,
  // 柔边档位（图集格子内的模糊半径 px），远 → 近
  feather: [14, 7, 2],
  // 昼夜交叉淡入时长，和 .wiki-bg / .wiki-glass 的 0.6s 过渡对齐
  mixTime: 0.6,
  // 帧率上限 45。粒子又慢又软、还压在玻璃后面，60fps 是纯浪费；
  // 45 下最近的花瓣每帧也只走 1.5px 出头。开销直接按比例降。
  fps: 45,
}

/* 画布按 CSS 尺寸的一半光栅化，再放大铺满视口。
   依据（真机 Chrome 实测，见 design-refs/falling-fx/SPEC.md 与 dpr-lab.html）：
   精灵本来就是预模糊过的柔光团，把位图按 1× 甚至 2× 光栅化再缩回去，
   多花的像素换不来任何可见清晰度——dpr 1 与 2 的逐像素差异 0.060/255，
   和「同一设置渲染两次」的噪声底 0.061/255 一样。
   代价是花瓣形状会糊：dpr 0.5 下缺口开始看不清，0.35 就只剩圆团（8× 放大比对过）。
   0.5 是「省一半填充率」和「还看得出是花瓣」的平衡点。 */
const DPR = 0.5

const CELL = 96  // 图集格子边长（设备像素）
const PAD = 1.5  // 形状只占格子的 1/1.5，给模糊留余量，否则糊到边上被裁掉

function createEngine(canvas) {
  const ctx = canvas.getContext('2d')
  const root = document.documentElement

  // canvas 2D 的 ctx.filter 不是所有浏览器都有，探一下
  const canFilter = (function () {
    const g = document.createElement('canvas').getContext('2d')
    try { g.filter = 'blur(2px)' } catch (e) { return false }
    return g.filter === 'blur(2px)'
  })()

  // 把形状画进 CELL×CELL 的离屏画布，顺带做柔边。
  // 有 ctx.filter 就一次真模糊；没有就绕着画十几遍、每遍 1/n 透明度，凑个近似。
  function bake(draw, feather) {
    const cv = document.createElement('canvas')
    cv.width = CELL
    cv.height = CELL
    const g = cv.getContext('2d')
    if (feather <= 0) { draw(g); return cv }
    if (canFilter) {
      g.filter = 'blur(' + feather + 'px)'
      draw(g)
      g.filter = 'none'
    } else {
      const n = 14
      const r = feather * 0.55
      g.globalAlpha = 1 / n
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        g.save()
        g.translate(Math.cos(a) * r, Math.sin(a) * r)
        draw(g)
        g.restore()
      }
    }
    return cv
  }

  // 樱花瓣：外缘带缺口，内端收窄
  function petalPath(g, cx, cy, w, h) {
    const top = cy - h / 2
    const bot = cy + h / 2
    const nw = w * 0.13
    const nd = h * 0.10
    g.beginPath()
    g.moveTo(cx - nw, top)
    g.quadraticCurveTo(cx - w * 0.62, top + h * 0.10, cx - w * 0.34, cy + h * 0.16)
    g.quadraticCurveTo(cx - w * 0.14, bot - h * 0.08, cx, bot)
    g.quadraticCurveTo(cx + w * 0.14, bot - h * 0.08, cx + w * 0.34, cy + h * 0.16)
    g.quadraticCurveTo(cx + w * 0.62, top + h * 0.10, cx + nw, top)
    g.quadraticCurveTo(cx, top + nd, cx - nw, top)
    g.closePath()
  }

  // 三档深浅，免得所有花瓣一个色。
  // 都偏饱和：底图是高调粉白，淡粉花瓣洗过之后会跟背景糊在一起，得压深一点才分得出。
  const PETAL_TINT = [
    ['#fbcfe0', '#f2a2c2', '#d9789f'],
    ['#fdd6e4', '#f0aac8', '#d5809f'],
    ['#f9c6d9', '#ee9cbe', '#d06e99'],
  ]

  function makePetalSprite(tint, feather) {
    return bake(function (g) {
      const w = CELL / PAD
      const h = CELL / PAD
      const cx = CELL / 2
      const cy = CELL / 2
      const grad = g.createRadialGradient(cx, cy + h * 0.18, 0, cx, cy + h * 0.18, w * 0.78)
      grad.addColorStop(0, tint[0])
      grad.addColorStop(0.55, tint[1])
      grad.addColorStop(1, tint[2])
      g.fillStyle = grad
      petalPath(g, cx, cy, w, h)
      g.fill()
    }, feather)
  }

  function makeSnowSprite(feather) {
    return bake(function (g) {
      const r = CELL / PAD / 2
      const grad = g.createRadialGradient(CELL / 2, CELL / 2, 0, CELL / 2, CELL / 2, r)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.5, 'rgba(228,239,255,0.86)')
      grad.addColorStop(1, 'rgba(200,220,255,0)')
      g.fillStyle = grad
      g.beginPath()
      g.arc(CELL / 2, CELL / 2, r, 0, Math.PI * 2)
      g.fill()
    }, feather)
  }

  // sprites[档位][变体]，档位 0 最远（最糊）
  const PETAL_SPRITES = CFG.feather.map(function (f) {
    return PETAL_TINT.map(function (t) { return makePetalSprite(t, f) })
  })
  const SNOW_SPRITES = CFG.feather.map(makeSnowSprite)

  /* ---------- 粒子 ---------- */

  function bandOf(z) {
    return z < 0.34 ? 0 : z < 0.67 ? 1 : 2
  }

  function makeParticle(kind, W, H, forceFar, seeded) {
    const isPetal = kind === 'petal'
    let z = Math.pow(Math.random(), CFG.zPow)
    // 近景满了就压回中景
    if (forceFar && z > CFG.nearZ) z = CFG.nearZ * Math.random()
    const s = 1 + z * CFG.scaleK
    const size = (isPetal ? CFG.petalSize : CFG.snowSize) * s
    return {
      z: z,
      size: size,
      band: bandOf(z),
      // 落速跟着尺度走——视差感主要靠这个，不是靠尺寸
      fall: (isPetal ? CFG.petalFall : CFG.snowFall) * s,
      alpha: CFG.aFar + (CFG.aNear - CFG.aFar) * z,
      x: 0,
      baseX: Math.random() * W,
      // 首次填充铺满整屏、靠 age 淡入；之后新粒子一律从屏幕上方外进场
      y: seeded ? Math.random() * H : -size - Math.random() * H * 0.4,
      age: 0,
      driftX: (Math.random() - 0.5) * (isPetal ? 14 : 9) * s,
      swayAmp: (isPetal ? 18 : 7) * (0.4 + Math.random() * 0.9) * s,
      swaySpd: 0.35 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI * 2,
      rotSpd: (Math.random() - 0.5) * (isPetal ? 1.2 : 0.35),
      tilt: Math.random() * Math.PI * 2,
      tiltSpd: 0.35 + Math.random() * 0.8,
      flip: 1,
      sprite: Math.floor(Math.random() * 3),
    }
  }

  function ensure(parts, target, kind, W, H) {
    let near = 0
    for (let i = 0; i < parts.length; i++) if (parts[i].z > CFG.nearZ) near++
    const seeded = parts.length === 0  // 空数组 = 首次填充
    while (parts.length < target) {
      const p = makeParticle(kind, W, H, near >= CFG.nearCap, seeded)
      if (p.z > CFG.nearZ) near++
      parts.push(p)
    }
  }

  function step(parts, dt, W, H, isPetal) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      p.age += dt
      p.y += p.fall * dt
      p.baseX += p.driftX * dt
      p.phase += p.swaySpd * dt
      p.rot += p.rotSpd * dt
      p.tilt += p.tiltSpd * dt
      p.x = p.baseX + Math.sin(p.phase) * p.swayAmp
      // 花瓣翻面：横向压扁到 0 再翻过来，看着像在打转
      p.flip = isPetal ? Math.cos(p.tilt) : 1
      if (p.baseX < -80) p.baseX += W + 160
      else if (p.baseX > W + 80) p.baseX -= W + 160
      if (p.y - p.size > H) parts.splice(i, 1)
    }
  }

  function draw(parts, setAlpha, isPetal, H) {
    if (setAlpha <= 0.005) return
    // 远 → 近：不排的话近处的花瓣会被远处的盖住
    parts.sort(function (a, b) { return a.z - b.z })
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      // 进出屏幕那几十像素里淡一下，避免凭空出现 / 消失
      const edge = Math.min(p.y, H - p.y)
      const edgeFade = edge >= 40 ? 1 : Math.max(0, edge / 40)
      const born = Math.min(1, p.age / 1.4)
      const a = p.alpha * setAlpha * edgeFade * born
      if (a <= 0.004) continue
      const sp = isPetal ? PETAL_SPRITES[p.band][p.sprite] : SNOW_SPRITES[p.band]
      const d = p.size * PAD
      // 平移 + 旋转 + 横向压扁合成成一个矩阵，一次 setTransform 落下去。
      // 拆成 translate/rotate/scale 再复位要四次调用，实测这一处占了逻辑开销的大头。
      const cs = Math.cos(p.rot)
      const sn = Math.sin(p.rot)
      ctx.globalAlpha = a
      ctx.setTransform(
        DPR * cs * p.flip, DPR * sn * p.flip,
        -DPR * sn, DPR * cs,
        DPR * p.x, DPR * p.y,
      )
      ctx.drawImage(sp, -d / 2, -d / 2, d, d)
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.globalAlpha = 1
  }

  /* ---------- 主循环 ---------- */

  let W = 0
  let H = 0
  let raf = 0
  let running = false
  let last = 0
  let mix = 0  // 0 = 白天，1 = 夜晚
  const petals = []
  const snow = []
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const narrow = matchMedia('(max-width: 959px)')
  const FRAME_MS = 1000 / CFG.fps

  // 正式站点用 .dark class（VitePress 自带切换按钮），不是 data-theme
  function isNight() {
    return root.classList.contains('dark')
  }

  function targetCount() {
    return Math.min(CFG.maxCount, Math.round(CFG.density * (W * H) / (1920 * 1080)))
  }

  function resize() {
    W = window.innerWidth
    H = window.innerHeight
    // 位图按 DPR 缩小，CSS 尺寸仍是整屏——canvas 是替换元素，不给 CSS 尺寸
    // 它就会按位图尺寸（W×DPR）显示，dpr 0.5 下只有半个屏幕宽。
    canvas.width = Math.round(W * DPR)
    canvas.height = Math.round(H * DPR)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    // 位置是 CSS 像素，尺寸变化不会挪动它们；只把跑到界外的夹回来，
    // 不重新播种——重新播种会让整片粒子在拖窗口时「重排」一下
    const sets = [petals, snow]
    for (let k = 0; k < 2; k++) {
      const arr = sets[k]
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i]
        if (p.baseX > W + 80 || p.baseX < -80) p.baseX = Math.random() * W
        if (p.y > H) p.y = -p.size - Math.random() * H * 0.3
      }
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame)
    // 限帧：没到点就直接返回。dt 是按「上次真正画的时刻」算的，
    // 所以粒子速度不受影响，只是采样点少了。
    if (now - last < FRAME_MS - 1) return
    const dt = Math.min(0.05, (now - last) / 1000 || 0)
    last = now

    // 昼夜交叉淡入，和 .wiki-bg / .wiki-glass 的 0.6s 过渡对齐
    const to = isNight() ? 1 : 0
    if (mix !== to) {
      const d = dt / CFG.mixTime
      mix = Math.abs(to - mix) <= d ? to : mix + Math.sign(to - mix) * d
    }
    const dayA = 1 - mix
    const nightA = mix

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const n = targetCount()
    if (dayA > 0.005) {
      ensure(petals, n, 'petal', W, H)
      step(petals, dt, W, H, true)
      draw(petals, dayA, true, H)
    } else if (petals.length) petals.length = 0

    if (nightA > 0.005) {
      ensure(snow, n, 'snow', W, H)
      step(snow, dt, W, H, false)
      draw(snow, nightA, false, H)
    } else if (snow.length) snow.length = 0
  }

  /* ---------- 生命周期 ---------- */

  function enabled() {
    return !reduceMotion.matches && !narrow.matches
  }

  function pause() {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  function resume() {
    if (running || !enabled()) return
    last = performance.now()
    running = true
    raf = requestAnimationFrame(frame)
  }

  // 停掉并把画布清干净（窄屏 / 减弱动态效果时走这里）
  function disable() {
    pause()
    petals.length = 0
    snow.length = 0
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function apply() {
    if (!enabled()) { disable(); return }
    resize()
    resume()
  }

  // 切到后台就停，别在后台还一直画。
  // 这一点比现有两个组件更要紧：它们都是滚动驱动 / 一次性的，这个是**只要页面开着
  // 就一直在跑**，不暂停的话笔记本合盖前一直在耗电。
  function onVisibility() {
    if (document.hidden) pause()
    else resume()
  }

  // resize 事件一次拖动会连发很多下，压到一帧一次
  let resizePending = false
  function onResize() {
    if (resizePending) return
    resizePending = true
    requestAnimationFrame(function () {
      resizePending = false
      apply()
    })
  }

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  reduceMotion.addEventListener('change', apply)
  narrow.addEventListener('change', apply)
  // 主题由 VitePress 改 <html> 的 .dark，每帧读一次就行，不用监听

  apply()

  return {
    destroy() {
      disable()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      reduceMotion.removeEventListener('change', apply)
      narrow.removeEventListener('change', apply)
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
</script>

<template>
  <canvas ref="canvasEl" class="wiki-fx" aria-hidden="true" />
</template>
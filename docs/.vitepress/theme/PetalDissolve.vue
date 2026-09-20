<script setup>
/* 顶栏下方的「沙粒消散」。
   ---------------------------------------------------------------------------
   要解决的问题：顶栏是透明的，正文滚到它下面就会和导航链接糊在一起。
   以前靠顶栏自己的 backdrop-filter 把正文糊掉。现在改成：正文在顶栏这一带
   一点点碎成沙粒，越往上散得越彻底，到屏幕最顶上完全散尽。

   消散线 = 顶栏底边。文字在这条线**往上**的 64px 里退场：
     刚碰到线         —— 字完整，沙粒也都还钉在原位
     往上 45% 处      —— 字已经彻底没了（不是淡出），只剩沙粒
     屏幕最顶         —— 沙粒散尽
   所以静止时顶栏下方不会平白少一行，文字贴着顶栏底边也是完整的。

   关键：**文字是「没了」而不是「淡出」**。一开始写成 1 − D^1.5 的连续淡出，
   结果整条带里文字一直可读、只是一路变淡，读起来是「淡下去的字 + 上面浮着些点」，
   不是「字碎成了点」。现在文字用 smoothstep 在带子 45% 高处就退干净（textGone），
   上面那 55% 只剩沙粒。

   沙粒凭什么能替掉文字：canvasui 的沙粒采样真实字形像素、落位时又长到盖满格子，
   沙粒本身就是那个字，交接是无缝的。我们没有内容纹理，就自己造一份——
   把页面上出现的每个字按它自己的字体渲染进一张图集、读回 alpha，拿到真正的
   笔画覆盖，然后只在有笔画的格点上放沙粒（见 buildAtlas / collectLines）。
   于是沙粒落位时拼出来就是那个字，往上飞散时自然碎开。

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
   沙粒位置改用 Range 逐字拿真实字框、再按字形图集采样笔画，所以照样是从字上飞出来的。

   可访问性：prefers-reduced-motion 下整个不启动，由 custom.css 把顶栏的 blur 放回来。
   窄屏（<960px）不启用——顶栏在窄屏是不透明的，正文不会从它下面过。 */
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import { GRAIN_DEFAULTS, grainD, makeGrain, grainState, smoothstep } from './grains.js'

const canvasEl = ref(null)
const route = useRoute()

const CFG = {
  ...GRAIN_DEFAULTS, // 沙粒的随机与运动参数，和首页开场共用（见 grains.js）
  // 格点边长 = 字形的采样精度。3px 时一个汉字约切 5×5 格，笔画能认出来。
  // 再细（2px）字形更清楚，但沙粒总数平方级涨、且细到看不出是一颗颗的沙；
  // 再粗（4px）字会糊成一坨方块。它同时是 grains.js 里"落位尺寸"的基准。
  density: 3,
  // 落位时沙粒边长 = density × grow。0.85 是「看得出来是一颗颗沙」和
  // 「拼起来能认出字」的平衡点：取 1 沙粒正好盖满格子、字形最实，
  // 但看上去像一块块像素而不像沙；取太小笔画又会断。首页那边是 0.45，
  // 因为它的格子铺在整个行盒上，盖满会变成一根实心条。
  grow: 0.85,
  curve: 1.5, // 消散曲线指数。越大，越靠近消弥线的字越"扛得住"，越往顶散得越快
  maskStep: 3, // mask 台阶高度（px）。段内 alpha 恒定，段间硬跳
  // 文字彻底退场的位置，单位是「占整条带的比例」。0.45 = 走到带子 45% 高处就没了，
  // 上面那 55% 只剩沙粒。见 writeMask()。
  textGone: 0.45,
  // 图集里 alpha 超过它才算"这一格有笔画"。抗锯齿的边缘 alpha 很低，
  // 阈值太低会把笔画之间的空隙填死、字就糊了（实测 40 糊、90 清楚）。
  inkAlpha: 90,
  // 沙粒总数上限，纯兜底。实测 677 字的页面约 1.75 万格（≈26 格/字），
  // 逐字采样总共 26ms；20 万格约等于一万字的页面，那时测量要 200ms 左右，
  // 是一次性的、可接受。真到截断的地步，被截掉的行只会少了沙粒、
  // 文字照样淡出，不会画错。
  maxCells: 200000,
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
  let lines = [] // [{ x0,top,bot, cells,ds,color, grains:Map }]  行盒，文档坐标
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

  // 正文里所有可见文本节点。标题后面那个 # 锚点、给读屏用的隐藏文字都不参与。
  function makeWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const p = n.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        if (p.closest('.header-anchor, .visually-hidden, script, style'))
          return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
  }

  // 把页面上出现的每个字按它自己的字体渲染一次，读回 alpha，得到真正的笔画覆盖。
  //
  // 为什么非得这么做：canvasui 的沙粒采样被 drawElementImage 捕获的内容纹理，
  // 每粒沙带着它那个像素的颜色，落位时长到盖满格子，拼起来就是无缝的字。
  // 我们拿不到内容纹理，只能用 measureText 的 actualBoundingBox* —— 但那只是
  // 墨迹的**外接矩形**，照着铺，"科"会变成一个实心方块，笔画全丢了。
  //
  // 关键是**按 字体+字符 去重后渲进同一张图集**，最后只读一次像素。
  // 逐字建 canvas + getImageData 实测 3.8ms/字，几百个唯一字要一两秒，没法用；
  // 图集化之后 313 个唯一字总共 13ms。
  function buildAtlas(items) {
    const list = [...items]
    const mc = document.createElement('canvas').getContext('2d')
    let maxW = 0
    let maxH = 0
    for (const it of list) {
      mc.font = it.font
      const m = mc.measureText(it.ch)
      // 墨迹框，相对字的对齐点（原点在基线上）。左边和上边是负方向，
      // 所以 l/t 取负号转成"从原点往右/往下多少"。
      it.l = -m.actualBoundingBoxLeft
      it.r = m.actualBoundingBoxRight
      it.t = -m.actualBoundingBoxAscent
      it.b = m.actualBoundingBoxDescent
      // 字体的整体上下界，用来把字框的顶边换算成基线位置（见 collectLines）
      it.fbA = m.fontBoundingBoxAscent
      it.fbD = m.fontBoundingBoxDescent
      // 留 1px 余量，抗锯齿的边缘也算进覆盖
      it.w = Math.max(1, Math.ceil(it.r - it.l) + 2)
      it.h = Math.max(1, Math.ceil(it.b - it.t) + 2)
      it.ox = -it.l + 1 // 图集里这个字的原点相对格子左上角的偏移
      it.oy = -it.t + 1
      maxW = Math.max(maxW, it.w)
      maxH = Math.max(maxH, it.h)
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)))
    const rows = Math.max(1, Math.ceil(list.length / cols))
    const AW = cols * maxW
    const AH = rows * maxH
    const cv = document.createElement('canvas')
    cv.width = AW
    cv.height = AH
    const g = cv.getContext('2d')
    g.fillStyle = '#000'
    g.textBaseline = 'alphabetic'
    list.forEach((it, i) => {
      it.cx = (i % cols) * maxW
      it.cy = Math.floor(i / cols) * maxH
      g.font = it.font
      g.fillText(it.ch, it.cx + it.ox, it.cy + it.oy)
    })
    return { px: g.getImageData(0, 0, AW, AH).data, W: AW }
  }

  // 只在这里读 DOM，之后每帧纯算术。
  //
  // 行是按「墨迹框顶边 + 文字色」分桶的。同一视觉行上的正文和链接颜色不同会分成
  // 两桶——它们的 top 一样，消散行为也一致，只是各用各的颜色画沙粒，正好。
  //
  // 每桶里的格点不是均匀网格，而是**只有笔画的地方才有格子**：
  // 逐字把它的墨迹框按 density 切成格，每格去图集里查有没有笔画，有才收下，
  // 位置取那一格里笔画像素的重心（不是格子中心）——这样沙粒落位拼出来是字，
  // 而不是一格子一格子的小方块。每格的时序偏移 d 也在这里算好（Float32Array），
  // 每帧再算的话是白烧 CPU。
  function collectLines(root, sy) {
    // --- 第一遍：页面上出现了哪些 (字体, 字符) ---
    const items = new Map()
    {
      const w = makeWalker(root)
      while (w.nextNode()) {
        const cs = getComputedStyle(w.currentNode.parentElement)
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        for (const ch of w.currentNode.nodeValue) {
          if (!ch.trim()) continue
          const k = font + '\u0000' + ch
          if (!items.has(k)) items.set(k, { font, ch })
        }
      }
    }
    if (!items.size) return
    const atlas = buildAtlas(items.values())

    // --- 第二遍：逐字采样笔画覆盖 ---
    const D = CFG.density
    const buckets = new Map()
    const rg = document.createRange()
    let total = 0
    const w2 = makeWalker(root)
    while (w2.nextNode() && total < CFG.maxCells) {
      const tn = w2.currentNode
      const cs = getComputedStyle(tn.parentElement)
      const color = cs.color
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const s = tn.nodeValue
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (!ch.trim()) continue
        const it = items.get(font + '\u0000' + ch)
        if (!it || !it.w) continue
        rg.setStart(tn, i)
        rg.setEnd(tn, i + 1)
        const rect = rg.getBoundingClientRect()
        if (rect.width < 0.5 || rect.height < 0.5) continue
        // 字框的顶边是字体上界，基线在它下面 fbA 处。字框高度未必等于
        // fbA + fbD（有的浏览器给的是行盒），所以先把字体盒在字框里居中再取基线。
        const baseY = rect.top + (rect.height - (it.fbA + it.fbD)) / 2 + it.fbA
        const inkL = rect.left + it.l
        const inkR = rect.left + it.r
        const inkT = baseY + it.t
        const inkB = baseY + it.b
        if (inkR - inkL < 0.5 || inkB - inkT < 0.5) continue

        const bkey = Math.round(inkT) + '\u0000' + color
        let bk = buckets.get(bkey)
        if (!bk) {
          bk = {
            top: rect.top + sy, // 文档坐标
            bot: rect.bottom + sy,
            x0: rect.left,
            color,
            cells: [],
          }
          buckets.set(bkey, bk)
        }
        if (rect.left < bk.x0) bk.x0 = rect.left
        if (rect.bottom + sy > bk.bot) bk.bot = rect.bottom + sy

        // 这个字的墨迹框按页面全局格点切开——格子对齐全局，相邻字的沙粒才连得上
        const ix1 = Math.floor((inkR - 0.01) / D)
        const iy1 = Math.floor((inkB - 0.01) / D)
        for (let iy = Math.floor(inkT / D); iy <= iy1; iy++) {
          for (let ix = Math.floor(inkL / D); ix <= ix1; ix++) {
            // 这一格和墨迹框的交集，页面坐标
            const px0 = Math.max(ix * D, inkL)
            const px1 = Math.min((ix + 1) * D, inkR)
            const py0 = Math.max(iy * D, inkT)
            const py1 = Math.min((iy + 1) * D, inkB)
            // 映射到图集坐标。必须夹在这个字自己的图集格子里，
            // 不然会采到隔壁字的笔画。
            const ax0 = Math.max(it.cx, Math.floor(px0 - rect.left + it.cx + it.ox))
            const ax1 = Math.min(it.cx + it.w, Math.ceil(px1 - rect.left + it.cx + it.ox))
            const ay0 = Math.max(it.cy, Math.floor(py0 - baseY + it.cy + it.oy))
            const ay1 = Math.min(it.cy + it.h, Math.ceil(py1 - baseY + it.cy + it.oy))
            let n = 0
            let sx = 0
            let syy = 0
            for (let ay = ay0; ay < ay1; ay++) {
              const row = ay * atlas.W
              for (let ax = ax0; ax < ax1; ax++) {
                if (atlas.px[(row + ax) * 4 + 3] > CFG.inkAlpha) {
                  n++
                  sx += ax
                  syy += ay
                }
              }
            }
            if (!n) continue
            // 沙粒落在笔画重心上，再换算成相对本桶左上角的偏移——
            // 存偏移而不是屏幕坐标，行盒往上走时沙粒才会跟着文字走
            bk.cells.push(
              sx / n - it.cx - it.ox + rect.left - bk.x0,
              syy / n - it.cy - it.oy + baseY + sy - bk.top,
            )
            total++
          }
        }
      }
    }

    let li = 0
    for (const bk of buckets.values()) {
      const n = bk.cells.length / 2
      if (!n) continue
      const ds = new Float32Array(n)
      for (let k = 0; k < n; k++) ds[k] = grainD(k, 0, li, CFG)
      lines.push({
        x0: bk.x0,
        top: bk.top,
        bot: bk.bot,
        cells: Float32Array.from(bk.cells),
        ds,
        color: bk.color,
        seed: li, // 给 grains.js 的 hash 用，让相邻两行的沙不长得一模一样
        // 格子索引 → 沙粒。用 Map 而不是数组：格子的激活顺序由 hash 决定，
        // 不是按下标顺序来的，数组会留一堆洞。
        grains: new Map(),
      })
      li++
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
      const a = (1 - smoothstep(0, CFG.textGone, (d - y1) / ramp)).toFixed(3)
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
  // 位置来自 collectLines 采出来的笔画重心，不是纯随机，所以是钉在字形上的。
  // 散开方向、时序偏移那些随机量来自 grains.js，和首页开场共用同一套。
  function makePetal(ln, k) {
    return {
      fx: ln.cells[k * 2],
      fy: ln.cells[k * 2 + 1],
      ...makeGrain(k, 0, ln.seed, CFG),
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
      const n = ln.ds.length
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
      ctx.fillStyle = ln.color
      for (const g of ln.grains.values()) {
        const st = grainState(g, g.t, now, CFG)
        if (st.alpha <= 0.01) continue
        const x = ln.x0 + g.fx + st.dx
        const y = lineY + g.fy + st.dy
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
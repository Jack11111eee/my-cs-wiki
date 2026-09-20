/* canvasui particle-scroll 的沙粒算法。PetalDissolve 和 HomeCondense 共用。
   ---------------------------------------------------------------------------
   两个组件用的是同一套「一格一粒沙」的随机与运动，只是时间轴不同：
     HomeCondense  一次性开场动画，t 由行在页面里的高度 + 已过时间决定
     PetalDissolve 滚动驱动，t 由这一格在顶栏带里的消散度决定
   所以把「随机参数」和「给定 t 求位移/尺寸/透明度」这两件事抽到这里，
   两边只负责各自的时间轴、画布和 mask。

   t 的定义统一为**凝聚进度**：t = 0 完全散开、t = 1 落在原位。
   文档页那边是「消散」的，所以它传 1 − 消散进度。

   参数单位一律 CSS 像素，时间单位秒。 */

export const GRAIN_DEFAULTS = {
  density: 6, // 格点边长（px）。越小沙越细，但沙粒总数会平方级涨
  size: 1.4, // 完全散开时沙粒的边长（px）
  spread: 150, // 最大飞散距离（px）
  gravity: 0.35, // 向下偏置，像沙往下沉。负值会往上飘
  drift: 0.7, // 漂浮速度。0 冻住
  swirl: 45, // 侧向弧线幅度（px）
  stagger: 0.7, // 每粒沙时序的参差程度。0 一起落，1 最参差
  fade: 0.85, // 完全散开时的不透明度
  grow: 0.45, // 落位时沙粒边长相对格点边长的比例。
  // 这里故意比 canvasui 小：原版让沙粒长到 1.3 倍格点、盖满自己的格子，
  // 因为它采样了真实内容像素，沙粒拼起来就是无缝的文字。
  // 我们拿不到像素，涨到盖满只会把行盒变成一个实心色块，所以只长大一点点。
}

// 和 canvasui 的 GLSL hash 同款：fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453)。
// 用它而不是 Math.random()，是为了让每粒沙的散开方向只由它的格点决定——
// 同一粒每帧算出来都一样，否则沙会在原地乱抖。
export function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// 一粒沙的时序偏移。文档页要在「还没生成沙粒」的时候就知道每格什么时候该开始碎，
// 所以单独拆出来——它在 measure() 时按格点批量算一次（存成 Float32Array），
// 而不是每帧现算：60fps × 上千格是白烧 CPU。
export function grainD(col, row, seed, cfg) {
  return hash2(col * 1.3 + seed * 0.37, row * 2.1 + seed * 0.11) * cfg.stagger
}

// 一个格子的随机参数。col/row 是格点在网格里的下标，seed 用来区分不同的区域
// （两个组件都传行号），这样相邻两行的沙不会长得一模一样。
// 只出随机量，不出位置——位置由调用方按自己的坐标系算（文档页存的是行内相对位置，
// 沙粒要跟着行盒滚）。
export function makeGrain(col, row, seed, cfg) {
  const h1 = hash2(col * 1.3 + seed * 0.37, row * 2.1 + seed * 0.11)
  const h2 = hash2(col * 4.7 + seed * 0.53, row * 1.9 + seed * 0.29)
  const h3 = hash2(col * 2.3 + seed * 0.71, row * 5.3 + seed * 0.43)
  const h4 = hash2(col * 3.1 + seed * 0.17, row * 7.7 + seed * 0.61)
  const ang = h2 * Math.PI * 2
  const dx = Math.cos(ang)
  const dy = Math.sin(ang)
  // reach 让大多数沙落在附近、少数飞得很远，云才有厚薄
  const reach = 0.08 + 0.92 * Math.pow(h4, 2.4)
  return {
    d: h1 * cfg.stagger, // 这一粒的时序偏移，和 grainD 同源
    offx: dx * cfg.spread * reach,
    offy: dy * cfg.spread * reach + cfg.gravity * cfg.spread * (0.25 + 0.75 * h4),
    px: -dy, // 与飞散方向垂直，用来做侧向弧线
    py: dx,
    f1: 4 + 5 * h2, // 漂浮的两个频率与相位
    f2: 3.5 + 5.5 * h3,
    p1: h3 * 40,
    p2: h2 * 40,
    jx: (h4 - 0.5) * cfg.density * 3, // 落地前的抖动
    jy: (h1 - 0.5) * cfg.density * 3,
  }
}

// 给定凝聚进度 t，算出这一粒沙相对它原位（home）的位移，以及此刻的尺寸和透明度。
// 全部照搬 canvasui 的 POINT_VERT：
//   e = 1 − (1 − t)³                     缓出
//   位移 = 散开偏移 × (1 − e)             从散开位插值回原位
//   + 侧向弧线 sin(e·π) × swirl          飞行途中往旁边绕一下
//   + 未落地时的正弦漂浮                  云才不会是一坨死点
//   + 快落地时的抖动                      像沙粒在找自己的位置
export function grainState(g, t, time, cfg) {
  const e = 1 - Math.pow(1 - t, 3)
  const k = 1 - e
  let dx = g.offx * k
  let dy = g.offy * k

  const arc = Math.sin(e * Math.PI) * cfg.swirl
  dx += g.px * arc
  dy += g.py * arc

  const amp = k * (cfg.spread * 0.05 + 2.5)
  const tt = time * cfg.drift
  dx += Math.sin(tt * g.f1 + g.p1) * amp
  dy += Math.cos(tt * g.f2 + g.p2) * amp

  const jit = 1 - smoothstep(0.5, 0.85, t)
  dx += g.jx * jit
  dy += g.jy * jit

  return {
    dx,
    dy,
    size: cfg.size + (cfg.density * cfg.grow - cfg.size) * smoothstep(0.55, 1, e),
    // 落地前淡出。原版是靠沙粒长到盖满格子、真实内容无缝接管，
    // 我们拿不到内容像素，所以改成淡出，避免最后一帧"啪"地跳一下。
    alpha: (cfg.fade + (1 - cfg.fade) * e) * (1 - smoothstep(0.9, 0.9995, t)),
  }
}
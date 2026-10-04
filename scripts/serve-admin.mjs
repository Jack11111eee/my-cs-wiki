// 本地后台的静态服务：只服务 admin/ 目录，不依赖任何第三方包。
// 后台不部署到公网，所以站点上没有 /admin 路由。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../admin/', import.meta.url))
const port = Number(process.env.PORT ?? 4173)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'

  const file = normalize(join(root, pathname))

  // 防目录穿越
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`内容后台已启动：http://localhost:${port}/`)
  console.log('只绑本机回环，同网段的其他设备访问不到。')
  console.log('编辑保存会用 PAT 直连 GitHub 提交，无需本地 commit + push。Ctrl+C 退出。')
})

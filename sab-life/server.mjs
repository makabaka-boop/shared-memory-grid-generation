/**
 * server.mjs — 零依赖静态服务器，附带 SharedArrayBuffer 所需的跨源隔离响应头。
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * 缺了它们浏览器会禁用 SharedArrayBuffer；页面会明确报错而不是回退单线程。
 * 用法：node server.mjs  （默认 http://localhost:8080，可用 PORT 环境变量覆盖）
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('./public', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, ISOLATION_HEADERS);
      res.end('forbidden');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      ...ISOLATION_HEADERS,
    });
    res.end(data);
  } catch {
    res.writeHead(404, ISOLATION_HEADERS);
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`生命游戏已启动: http://localhost:${PORT}/`);
  console.log('（已附带 COOP/COEP 跨源隔离响应头，SharedArrayBuffer 可用）');
});

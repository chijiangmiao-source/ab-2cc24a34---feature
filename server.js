'use strict';
/*
 * server.js —— 审计页面静态服务 + /healthz。
 * 宿主机映射端口由 Compose 的 HOST_PORT / PORT 环境变量配置。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/healthz') {
    return sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  let rel = url === '/' ? '/index.html' : url;
  // 防路径穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: 'server error' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('光阑换位审计页面已启动：http://0.0.0.0:' + PORT + '/（/healthz 就绪探针）');
});

function shutdown(sig) {
  console.log('收到 ' + sig + '，关闭 HTTP 服务…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

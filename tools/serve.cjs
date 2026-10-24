#!/usr/bin/env node
/*
 * tools/serve.cjs —— 零依赖静态服务器（本地测试 PWA / 验证脚本共用）
 *
 *   node tools/serve.cjs [端口，默认 8080]   → http://127.0.0.1:8080/
 *
 * 作为模块使用：
 *   const { createStaticServer } = require('./serve.cjs');
 *   const srv = await createStaticServer({ root, port: 0 });
 *   srv.url; srv.state.offline = true;       // 模拟断网：直接掐断连接
 *   srv.state.overrides.set('/sw.js', { body, type });  // 模拟发版
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function createStaticServer(options) {
  const root = path.resolve(options.root);
  const state = { offline: false, overrides: new Map(), requests: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (state.offline) {
      req.socket.destroy();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    state.requests.push(pathname);
    const headers = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    const override = state.overrides.get(pathname);
    if (override) {
      res.writeHead(200, Object.assign(headers, { 'Content-Type': override.type || MIME[path.extname(pathname)] || 'application/octet-stream' }));
      res.end(override.body);
      return;
    }
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
        return;
      }
      res.writeHead(200, Object.assign(headers, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }));
      res.end(data);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, options.host || '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        state,
        port,
        url: `http://127.0.0.1:${port}/`,
        dropConnections() {
          for (const s of sockets) s.destroy();
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

module.exports = { createStaticServer };

if (require.main === module) {
  const port = parseInt(process.argv[2], 10) || 8080;
  createStaticServer({ root: path.join(__dirname, '..'), port }).then((srv) => {
    console.log(`贪吃蛇已启动：${srv.url}（Ctrl+C 退出）`);
  });
}

/*
 * sw.js —— 离线 / 更新策略
 *
 * - 网络优先 + 缓存兜底（含导航请求）：在线时永远拿最新代码，并顺手刷新缓存；
 *   断网时回退到缓存，导航请求兜底到 index.html。
 * - install 预缓存全部静态资源并 skipWaiting；activate 清理旧版本缓存并 clients.claim。
 * - 发版时：修改 VERSION，并同步更新 index.html 与下方 ASSETS 中的 ?v= 版本号。
 */
'use strict';

const VERSION = 'v1';
const CACHE = `snake-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './style.css?v=1',
  './ai.js?v=1',
  './game.js?v=1',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('snake-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event, req));
});

async function networkFirst(event, req) {
  const cache = await caches.open(CACHE);
  try {
    // 导航请求不能带 RequestInit 重新构造；其它请求强制向服务器校验，绕过 HTTP 缓存
    const fresh = await fetch(req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' }));
    if (fresh && fresh.ok && fresh.type === 'basic') {
      event.waitUntil(cache.put(req, fresh.clone()).catch(() => {}));
    }
    return fresh;
  } catch (err) {
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response('离线且无缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

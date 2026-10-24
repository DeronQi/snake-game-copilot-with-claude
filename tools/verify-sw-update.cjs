#!/usr/bin/env node
/*
 * tools/verify-sw-update.cjs —— Service Worker 离线 / 更新验证（Playwright + Chromium）
 *
 * 1. 首次访问：SW 安装并接管页面，预缓存全部静态资源（不触发自动刷新）。
 * 2. 断网刷新：页面仍可从缓存加载并开始游戏。
 * 3. 往 Cache Storage 塞入「旧版」game.js / style.css / index.html，在线刷新后
 *    必须加载到新代码（网络优先），且缓存被新内容覆盖；再次断网刷新仍是新代码。
 * 4. 模拟发版（服务器返回内容变化的 sw.js）：刷新后新 SW 接管，页面自动 reload 一次，
 *    旧版本缓存被清理。
 *
 * 用法：node tools/verify-sw-update.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createStaticServer } = require('./serve.cjs');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    /* 尝试全局安装 */
  }
  try {
    return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
  } catch (e) {
    console.error('✗ 未找到 Playwright：请先执行 npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

let total = 0;
let failed = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

/** 从 sw.js 读取当前缓存名与资源清单，保证测试与实现同步 */
function readSwConfig() {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const version = /const VERSION = '([^']+)'/.exec(src)[1];
  const assets = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(src)[1].replace(/'/g, '"'));
  return { src, version, cache: `snake-${version}`, assets };
}

async function snapshot(page) {
  return page.evaluate(() => ({
    oldGame: !!window.__OLD_GAME__,
    hasAI: typeof window.SnakeAI === 'object',
    oldIndex: document.body.innerText.includes('OLD-INDEX'),
    hasStart: !!document.getElementById('panelStart'),
    bg: getComputedStyle(document.body).backgroundColor,
    bgImage: getComputedStyle(document.body).backgroundImage,
    title: document.title,
    controlled: !!navigator.serviceWorker.controller
  }));
}

async function main() {
  const { chromium } = loadPlaywright();
  const cfg = readSwConfig();
  const srv = await createStaticServer({ root: ROOT, port: 0 });
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  let phase = 'online';
  const errors = { online: [], offline: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') errors[phase].push(m.text());
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  let navigations = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });

  console.log(`静态服务器：${srv.url}（SW 版本 ${cfg.version}，预缓存 ${cfg.assets.length} 项）`);
  try {
    // ------------------------------------------------------------- 1. 首次安装
    console.log('\n■ 首次访问：安装 Service Worker');
    await page.goto(srv.url, { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
    await page.waitForFunction(
      async ({ cache, n }) => {
        if (!(await caches.has(cache))) return false;
        const c = await caches.open(cache);
        return (await c.keys()).length >= n;
      },
      { cache: cfg.cache, n: cfg.assets.length },
      { timeout: 20000 }
    );
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      const urls = [];
      for (const k of keys) {
        const c = await caches.open(k);
        for (const r of await c.keys()) urls.push(new URL(r.url).pathname + new URL(r.url).search);
      }
      return { scope: reg && reg.scope, updateViaCache: reg && reg.updateViaCache, keys, urls };
    });
    check('SW 已注册并接管页面', !!info.scope, info.scope);
    check("注册参数 updateViaCache = 'none'", info.updateViaCache === 'none');
    check(`缓存名为 ${cfg.cache}`, info.keys.length === 1 && info.keys[0] === cfg.cache, info.keys.join(','));
    const expected = cfg.assets.map((a) => new URL(a, srv.url).pathname + new URL(a, srv.url).search);
    check('预缓存全部静态资源（含带版本号的 ?v=1）', expected.every((u) => info.urls.includes(u)), `${info.urls.length} 项`);
    await sleep(500);
    check('首次安装不触发自动刷新', navigations === 1, `导航 ${navigations} 次`);

    // ------------------------------------------------------------- 2. 断网刷新
    console.log('\n■ 断网后刷新');
    phase = 'offline';
    srv.state.offline = true;
    srv.dropConnections();
    await page.reload({ waitUntil: 'load' });
    let s = await snapshot(page);
    check('断网刷新仍能加载页面与脚本', s.hasStart && s.hasAI, `title=${s.title}`);
    check('断网刷新样式正常', s.bgImage.includes('gradient'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.state === 'playing', null, { timeout: 5000 });
    check('断网状态下可以开始游戏', true);
    srv.state.offline = false;
    phase = 'online';

    // ------------------------------------------------------------- 3. 旧缓存投毒
    console.log('\n■ 缓存中塞入旧版 game.js / style.css / index.html 后在线刷新');
    await page.evaluate(async (cache) => {
      const c = await caches.open(cache);
      const put = (u, body, type) => c.put(new Request(u), new Response(body, { headers: { 'Content-Type': type } }));
      const oldHtml =
        '<!doctype html><html><head><title>OLD</title><link rel="stylesheet" href="style.css?v=1"></head>' +
        '<body>OLD-INDEX<script src="game.js?v=1"></script></body></html>';
      await put('game.js?v=1', 'window.__OLD_GAME__ = true; document.title = "OLD";', 'text/javascript');
      await put('style.css?v=1', 'body{background:rgb(1,2,3)!important}', 'text/css');
      await put('./', oldHtml, 'text/html');
      await put('index.html', oldHtml, 'text/html');
    }, cfg.cache);
    const poisoned = await page.evaluate(async (cache) => {
      const c = await caches.open(cache);
      const r = await c.match('game.js?v=1');
      return (await r.text()).includes('__OLD_GAME__');
    }, cfg.cache);
    check('旧版资源已写入 Cache Storage', poisoned);
    await page.reload({ waitUntil: 'load' });
    s = await snapshot(page);
    check('在线刷新加载到新 index.html', s.hasStart && !s.oldIndex);
    check('在线刷新加载到新 game.js / ai.js', s.hasAI && !s.oldGame && s.title !== 'OLD', `title=${s.title}`);
    check('在线刷新加载到新 style.css', s.bg !== 'rgb(1, 2, 3)' && s.bgImage.includes('gradient'), s.bg);
    await sleep(300);
    const refreshed = await page.evaluate(async (cache) => {
      const c = await caches.open(cache);
      const txt = async (u) => {
        const r = await c.match(u);
        return r ? r.text() : '';
      };
      return {
        game: !(await txt('game.js?v=1')).includes('__OLD_GAME__'),
        css: !(await txt('style.css?v=1')).includes('rgb(1,2,3)'),
        html: !(await txt('./')).includes('OLD-INDEX')
      };
    }, cfg.cache);
    check('网络优先：缓存被新内容覆盖', refreshed.game && refreshed.css && refreshed.html, JSON.stringify(refreshed));

    phase = 'offline';
    srv.state.offline = true;
    srv.dropConnections();
    await page.reload({ waitUntil: 'load' });
    s = await snapshot(page);
    check('再次断网刷新：仍是新代码', s.hasStart && s.hasAI && !s.oldGame && !s.oldIndex);
    srv.state.offline = false;
    phase = 'online';

    // ------------------------------------------------------------- 4. 发版自动更新
    console.log('\n■ 模拟发版：sw.js 内容变化');
    const newVersion = `${cfg.version}-next`;
    srv.state.overrides.set('/sw.js', {
      body: cfg.src.replace(`const VERSION = '${cfg.version}'`, `const VERSION = '${newVersion}'`),
      type: 'text/javascript; charset=utf-8'
    });
    const navBefore = navigations;
    await page.reload({ waitUntil: 'load' });
    const t0 = Date.now();
    while (navigations - navBefore < 2 && Date.now() - t0 < 20000) await sleep(100);
    const reloadMs = Date.now() - t0;
    await page.waitForLoadState('load');
    await sleep(2000); // 观察是否出现重复刷新
    check('新 SW 接管后页面自动 reload 一次', navigations - navBefore === 2, `刷新后共导航 ${navigations - navBefore} 次，自动刷新耗时约 ${reloadMs}ms`);
    const after = await page.evaluate(async () => ({
      keys: await caches.keys(),
      controlled: !!navigator.serviceWorker.controller,
      hasStart: !!document.getElementById('panelStart'),
      hasAI: typeof window.SnakeAI === 'object'
    }));
    check(`旧缓存已清理，仅剩 snake-${newVersion}`, after.keys.length === 1 && after.keys[0] === `snake-${newVersion}`, after.keys.join(','));
    check('更新后页面正常且仍受 SW 控制', after.controlled && after.hasStart && after.hasAI);

    check('页面脚本 0 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    check('在线阶段浏览器控制台 0 报错', errors.online.length === 0, errors.online.slice(0, 3).join(' | '));
    if (errors.offline.length) {
      console.log(`  · 断网阶段浏览器自身输出 ${errors.offline.length} 条网络错误（预期内，例如 SW 更新检查失败）：${errors.offline[0].slice(0, 120)}`);
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(`\n合计 ${total} 项断言，${total - failed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

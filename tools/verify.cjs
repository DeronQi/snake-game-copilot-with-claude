#!/usr/bin/env node
/*
 * tools/verify.cjs —— 浏览器端到端验证（Playwright + Chromium）
 *
 * 四种环境：桌面 1280×820、手机竖屏 390×844、横屏 844×390、小屏 320×568。
 * 用 canvas 像素识别蛇头 / 蛇身 / 果实，并通过真实输入（键盘、屏幕方向键、触摸滑动）自动游玩。
 *
 * 断言：棋盘正方形且完整可见 / 页面无滚动溢出 / 难度切换并持久化 / 计分 / 升级 /
 *       暂停恢复 / 失焦自动暂停 / R 重开不丢分 / 最高分吃到即落盘且刷新后保留 /
 *       标题同步 / AI 在浏览器内填满棋盘（397 分）/ 控制台 0 报错 / file:// 直接打开可玩。
 *
 * 用法：node tools/verify.cjs            （需要 Playwright：npm i -D playwright 或全局安装）
 *       HEADED=1 node tools/verify.cjs   （有界面模式观察）
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');
const { createStaticServer } = require('./serve.cjs');
const SnakeAI = require('../ai.js');

const ROOT = path.resolve(__dirname, '..');
const N = SnakeAI.COLS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    /* 尝试全局安装 */
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch (e) {
    console.error('✗ 未找到 Playwright：请先执行 npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 断言记录
// ---------------------------------------------------------------------------
let total = 0;
let failed = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

// ---------------------------------------------------------------------------
// 页面内执行：canvas 像素识别
//   蛇头 rgb(214,255,240)、果实 #ff3b5c、蛇身为绿色渐变（尾 16,110,78 → 颈 88,255,170）
//   只采样每格中心像素，眼睛 / 高光都偏离中心，不影响识别。
// ---------------------------------------------------------------------------
function readBoardInPage(n) {
  const cv = document.getElementById('board');
  const g = cv.getContext('2d');
  const W = cv.width;
  const cell = W / n;
  const data = g.getImageData(0, 0, W, W).data;
  let head = null;
  let fruit = null;
  const body = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = Math.floor((x + 0.5) * cell);
      const py = Math.floor((y + 0.5) * cell);
      const i = (py * W + px) * 4;
      const r = data[i];
      const gg = data[i + 1];
      const b = data[i + 2];
      if (r > 190 && gg > 225 && b > 190) head = { x, y };
      else if (r > 200 && gg < 120 && b < 160) fruit = { x, y };
      else if (gg >= 100 && gg > r + 50) body.push(y * n + x);
    }
  }
  const $ = (id) => document.getElementById(id);
  return {
    head,
    fruit,
    body,
    score: Number($('score').textContent),
    best: Number($('best').textContent),
    speed: $('speed').textContent,
    title: document.title,
    state: document.body.dataset.state,
    lsBest: localStorage.getItem('snake.best')
  };
}

const readBoard = (page) => page.evaluate(readBoardInPage, N);

// ---------------------------------------------------------------------------
// 自动游玩：贪心靠近果实 + 洪水填充避免钻进死路
// ---------------------------------------------------------------------------
const MOVES = [
  ['up', 0, -1],
  ['down', 0, 1],
  ['left', -1, 0],
  ['right', 1, 0]
];
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

function flood(start, blocked) {
  const seen = new Uint8Array(N * N);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length) {
    const c = stack.pop();
    count++;
    const x = c % N;
    const y = (c / N) | 0;
    for (const [, dx, dy] of MOVES) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const ni = ny * N + nx;
      if (seen[ni] || blocked.has(ni)) continue;
      seen[ni] = 1;
      stack.push(ni);
    }
  }
  return count;
}

function chooseDir(board, curDir) {
  const blocked = new Set(board.body);
  blocked.add(board.head.y * N + board.head.x);
  const len = board.body.length + 1;
  const opts = [];
  for (const [name, dx, dy] of MOVES) {
    if (name === OPP[curDir]) continue;
    const nx = board.head.x + dx;
    const ny = board.head.y + dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    const ni = ny * N + nx;
    if (blocked.has(ni)) continue;
    const space = flood(ni, blocked);
    const dist = board.fruit ? Math.abs(nx - board.fruit.x) + Math.abs(ny - board.fruit.y) : 0;
    opts.push({ name, safe: space >= len + 2, space, dist });
  }
  if (!opts.length) return curDir;
  opts.sort((a, b) => b.safe - a.safe || a.dist - b.dist || b.space - a.space);
  return opts[0].name;
}

function dirOf(dx, dy) {
  if (dx === 1 && dy === 0) return 'right';
  if (dx === -1 && dy === 0) return 'left';
  if (dx === 0 && dy === 1) return 'down';
  if (dx === 0 && dy === -1) return 'up';
  return null;
}

/** 按环境用不同的真实输入方式发送方向 */
async function sendDir(page, env, dir) {
  if (env.input === 'keyboard') {
    const keys = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
    // 交替使用方向键与 WASD，两种都覆盖到
    const wasd = { up: 'w', down: 's', left: 'a', right: 'd' };
    env._alt = !env._alt;
    await page.keyboard.press(env._alt ? keys[dir] : wasd[dir]);
  } else if (env.input === 'dpad') {
    const p = env._dpad[dir];
    await page.touchscreen.tap(p.x, p.y);
  } else {
    // 触摸滑动：通过 CDP 发送真实 touchStart / touchMove / touchEnd
    const c = env._boardCenter;
    const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    const cdp = env._cdp;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + v[0] * 20, y: c.y + v[1] * 20 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + v[0] * 44, y: c.y + v[1] * 44 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

async function autoPlay(page, env, targetScore, timeoutMs) {
  const stats = { maxScore: 0, deaths: 0, titleMismatch: [], bestLag: [], levelOk: null, inputs: 0, timedOut: false };
  let lastHead = null;
  let curDir = 'right';
  const t0 = Date.now();
  while (true) {
    if (Date.now() - t0 > timeoutMs) {
      stats.timedOut = true;
      break;
    }
    const b = await readBoard(page);
    if (b.state === 'over') {
      stats.deaths++;
      await page.keyboard.press('Enter');
      lastHead = null;
      curDir = 'right';
      await sleep(60);
      continue;
    }
    if (b.state === 'paused') {
      await page.keyboard.press('p');
      continue;
    }
    if (b.state !== 'playing' || !b.head) {
      await sleep(10);
      continue;
    }
    stats.maxScore = Math.max(stats.maxScore, b.score);
    if (b.title !== `得分 ${b.score} · 贪吃蛇`) stats.titleMismatch.push(`${b.title} / score=${b.score}`);
    if (Number(b.lsBest) < b.score) stats.bestLag.push(`ls=${b.lsBest} score=${b.score}`);
    if (b.score >= SnakeAI.POINTS_PER_LEVEL) {
      const expect = `${SnakeAI.levelForScore(b.score)} 级`;
      stats.levelOk = (stats.levelOk !== false) && b.speed === expect;
    }
    if (b.score >= targetScore) break;
    if (!lastHead || b.head.x !== lastHead.x || b.head.y !== lastHead.y) {
      if (lastHead) curDir = dirOf(b.head.x - lastHead.x, b.head.y - lastHead.y) || 'right';
      lastHead = b.head;
      const want = chooseDir(b, curDir);
      if (want !== curDir) {
        await sendDir(page, env, want);
        stats.inputs++;
      }
    } else {
      await sleep(8);
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// 布局测量
// ---------------------------------------------------------------------------
function measureInPage() {
  const $ = (id) => document.getElementById(id);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const cv = $('board');
  const de = document.documentElement;
  const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const openPanel = [...document.querySelectorAll('.panel')].find((p) => !p.hidden);
  return {
    board: rect(cv),
    canvasW: cv.width,
    canvasH: cv.height,
    dpr: window.devicePixelRatio,
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
    scrollH: Math.max(de.scrollHeight, document.body.scrollHeight),
    buttons: [...document.querySelectorAll('.topbar button')].map(rect),
    stats: [...document.querySelectorAll('.stat')].map(rect),
    dpadVisible: visible($('dpad')),
    dpadRect: visible($('dpad')) ? rect($('dpad')) : null,
    keyHintVisible: visible(document.querySelector('.hint-keys')),
    touchClass: document.body.classList.contains('touch'),
    panelOverflow: openPanel ? openPanel.scrollHeight - openPanel.clientHeight : 0,
    panelRect: openPanel ? rect(openPanel) : null
  };
}

function inViewport(r, m) {
  return r.x >= -0.5 && r.y >= -0.5 && r.right <= m.vw + 0.5 && r.bottom <= m.vh + 0.5;
}

async function checkLayout(page, env, label) {
  const m = await page.evaluate(measureInPage);
  const side = m.board.w;
  check(`[${label}] 棋盘为正方形`, Math.abs(m.board.w - m.board.h) < 0.5 && m.canvasW === m.canvasH, `${m.board.w}×${m.board.h} css, ${m.canvasW}×${m.canvasH} px`);
  check(`[${label}] 棋盘完整可见`, inViewport(m.board, m), `x=${m.board.x.toFixed(0)} y=${m.board.y.toFixed(0)} → ${m.board.right.toFixed(0)},${m.board.bottom.toFixed(0)} / 视口 ${m.vw}×${m.vh}`);
  check(`[${label}] 棋盘充分利用空间`, side >= Math.min(m.vw, m.vh) * 0.6, `边长 ${side}px`);
  const expectPx = Math.round((side * Math.min(m.dpr, 2.5)) / N) * N;
  check(`[${label}] canvas 按 DPR 高清渲染（上限 2.5）`, Math.abs(m.canvasW - expectPx) <= N, `dpr=${m.dpr} → ${m.canvasW}px`);
  check(`[${label}] 页面无滚动溢出`, m.scrollW <= m.vw && m.scrollH <= m.vh, `scroll ${m.scrollW}×${m.scrollH}`);
  check(`[${label}] 顶部按钮与计分全部可见`, m.buttons.every((r) => inViewport(r, m)) && m.stats.every((r) => inViewport(r, m)));
  if (m.panelRect) {
    check(`[${label}] 弹层完整显示无需内部滚动`, m.panelOverflow <= 1 && inViewport(m.panelRect, m), `overflow=${m.panelOverflow}`);
  }
  if (env.expectDpad) {
    check(`[${label}] 触屏竖屏显示方向键`, m.dpadVisible && inViewport(m.dpadRect, m) && !m.keyHintVisible);
  } else if (env.touch) {
    check(`[${label}] 横屏紧凑模式隐藏方向键（改用滑动）`, !m.dpadVisible);
  } else {
    check(`[${label}] 桌面显示键盘提示、无方向键`, m.keyHintVisible && !m.dpadVisible);
  }
  return m;
}

async function tapOrClick(page, env, selector) {
  if (env.touch) await page.locator(selector).tap();
  else await page.locator(selector).click();
}

async function waitState(page, state, timeout = 5000) {
  await page.waitForFunction((s) => document.body.dataset.state === s, state, { timeout });
}

async function headPos(page) {
  const b = await readBoard(page);
  return b.head ? `${b.head.x},${b.head.y}` : 'none';
}

// ---------------------------------------------------------------------------
// 单个环境的完整流程
// ---------------------------------------------------------------------------
async function runEnv(browser, baseURL, env) {
  console.log(`\n■ ${env.name}（${env.viewport.width}×${env.viewport.height}，${env.touch ? '触屏' : '键鼠'}，输入：${env.input}）`);
  const context = await browser.newContext({
    viewport: env.viewport,
    deviceScaleFactor: env.dpr,
    isMobile: env.touch,
    hasTouch: env.touch
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto(baseURL, { waitUntil: 'load' });
  await page.waitForSelector('#panelStart:not([hidden])');
  await checkLayout(page, env, '开始界面');

  // AI 入口
  const aiBtn = page.locator('#btnStartAI');
  check('开始界面可见「🤖 看 AI 演示」整行按钮', (await aiBtn.isVisible()) && (await aiBtn.textContent()).includes('🤖 看 AI 演示'));

  // 难度：切换 → 高亮 → 刷新后保持
  await tapOrClick(page, env, '[data-diff="hard"]');
  const hardPressed = await page.getAttribute('[data-diff="hard"]', 'aria-pressed');
  const others = await page.$$eval('[data-diff]', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').length);
  check('分段选择器高亮当前难度', hardPressed === 'true' && others === 1);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#panelStart:not([hidden])');
  check('难度选择持久化（刷新后仍为「困难」）', (await page.getAttribute('[data-diff="hard"]', 'aria-pressed')) === 'true', await page.textContent('#diffHint'));
  await tapOrClick(page, env, '[data-diff="easy"]');
  check('切换到「简单」', (await page.evaluate(() => localStorage.getItem('snake.difficulty'))) === 'easy');

  // 准备输入通道的坐标
  const m = await page.evaluate(measureInPage);
  env._boardCenter = { x: m.board.x + m.board.w / 2, y: m.board.y + m.board.h / 2 };
  if (env.input === 'dpad') {
    env._dpad = {};
    for (const d of ['up', 'down', 'left', 'right']) {
      const r = await page.locator(`#dpad [data-dir="${d}"]`).boundingBox();
      env._dpad[d] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const r = await page.locator('#dpad [data-action="pause"]').boundingBox();
    env._dpad.mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  if (env.input === 'swipe') env._cdp = await context.newCDPSession(page);

  // 开始游戏
  await tapOrClick(page, env, '#btnStart');
  await waitState(page, 'playing');
  check('点击「开始游戏」进入游戏', true);
  check('标题同步：得分 0 · 贪吃蛇', (await page.title()) === '得分 0 · 贪吃蛇', await page.title());
  await checkLayout(page, env, '游戏中');

  // 暂停 / 恢复（开局蛇向右有足够空间）
  await sleep(300);
  if (env.input === 'keyboard') await page.keyboard.press('Space');
  else if (env.input === 'dpad') await page.touchscreen.tap(env._dpad.mid.x, env._dpad.mid.y);
  else await page.locator('#btnPause').tap();
  await waitState(page, 'paused');
  const h1 = await headPos(page);
  await sleep(700);
  const h2 = await headPos(page);
  const pausedTitle = await page.title();
  check('暂停后蛇不再移动', h1 === h2 && h1 !== 'none', `${h1} → ${h2}`);
  check('标题同步：已暂停 · 得分 0 · 贪吃蛇', pausedTitle === '已暂停 · 得分 0 · 贪吃蛇', pausedTitle);
  check('暂停面板可见', await page.isVisible('#panelPause'));
  if (env.input === 'keyboard') await page.keyboard.press('Space');
  else await page.locator('#btnResume').tap();
  await waitState(page, 'playing');
  await sleep(600);
  const h3 = await headPos(page);
  check('恢复后继续移动', h3 !== h2, `${h2} → ${h3}`);

  // 失焦自动暂停
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('窗口失焦自动暂停', (await page.evaluate(() => document.body.dataset.state)) === 'paused');
  await tapOrClick(page, env, '#btnResume');
  await waitState(page, 'playing');

  // 真正自动游玩：计分 / 升级 / 最高分即时落盘 / 标题同步
  const target = 5;
  const t0 = Date.now();
  const st = await autoPlay(page, env, target, 150000);
  check(`像素识别自动游玩达到 ${target} 分`, st.maxScore >= target && !st.timedOut, `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，输入 ${st.inputs} 次，死亡 ${st.deaths} 次`);
  check('计分与升级正确（≥4 分时速度为 2 级）', st.levelOk === true);
  check('最高分在吃到果实的瞬间写入 localStorage', st.bestLag.length === 0, st.bestLag.slice(0, 2).join('; '));
  check('游戏中标题实时同步得分', st.titleMismatch.length === 0, st.titleMismatch.slice(0, 2).join('; '));

  // R 中途重开不丢最高分
  const before = await readBoard(page);
  await page.keyboard.press('r');
  await page.waitForFunction(() => document.getElementById('score').textContent === '0');
  const after = await readBoard(page);
  check('R 随时重开：得分归零', after.score === 0 && after.state === 'playing');
  check('R 重开不丢最高分', after.best >= before.score && Number(after.lsBest) >= before.score, `best=${after.best} ls=${after.lsBest} 重开前得分=${before.score}`);

  // 刷新后最高分仍在
  const bestBefore = Number(after.lsBest);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#panelStart:not([hidden])');
  const bestDom = Number(await page.textContent('#best'));
  const startBest = Number(await page.textContent('#startBest'));
  check('刷新后最高分保留', bestDom === bestBefore && startBest === bestBefore, `最高分 ${bestDom}`);

  // AI 演示：任意难度下填满棋盘
  const diff = env.aiDifficulty;
  await tapOrClick(page, env, `[data-diff="${diff}"]`);
  await tapOrClick(page, env, '#btnStartAI');
  await waitState(page, 'playing');
  check('AI 演示条显示「🤖 AI 演示中」', (await page.isVisible('#aiBar')) && (await page.textContent('#aiBar')).includes('🤖 AI 演示中'));
  check('右上角 🤖 按钮 aria-pressed=true', (await page.getAttribute('#btnAI', 'aria-pressed')) === 'true');
  const labels = [];
  for (let i = 0; i < 5; i++) {
    const t = (await page.textContent('#btnAISpeed')).trim();
    labels.push(t);
    if (t === 'MAX') break;
    await tapOrClick(page, env, '#btnAISpeed');
  }
  check('倍速循环 ×1 → ×4 → ×16 → ×64 → MAX', labels.join(',') === '×1,×4,×16,×64,MAX', labels.join(' → '));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft'); // 演示时玩家方向输入应被忽略
  const aiStart = Date.now();
  let pausedSeen = 0;
  await page.evaluate(() => {
    window.__vfFrames = 0;
    const f = () => {
      window.__vfFrames++;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  let lastLog = Date.now();
  let lastFrames = 0;
  while (Date.now() - aiStart < 180000) {
    const s = await page.evaluate(() => [document.body.dataset.state, document.getElementById('score').textContent, window.__vfFrames, document.getElementById('btnAISpeed').textContent]);
    if (s[0] === 'won' || s[0] === 'over') break;
    if (s[0] === 'paused') {
      pausedSeen++;
      await page.keyboard.press('p');
    }
    if (Date.now() - lastLog >= 5000) {
      console.log(`  · AI 进度 ${((Date.now() - aiStart) / 1000).toFixed(0)}s：得分 ${s[1]}，倍速 ${s[3]}，${((s[2] - lastFrames) / ((Date.now() - lastLog) / 1000)).toFixed(0)} fps`);
      lastLog = Date.now();
      lastFrames = s[2];
    }
    await sleep(250);
  }
  const aiSecs = ((Date.now() - aiStart) / 1000).toFixed(1);
  const fin = await readBoard(page);
  const winMsg = (await page.textContent('#winMsg')) || '';
  check(`AI 在浏览器内填满棋盘（难度：${diff}）`, fin.state === 'won' && fin.score === 397, `状态=${fin.state} 得分=${fin.score} 用时 ${aiSecs}s`);
  check('通关面板文案', winMsg === 'AI 通关！AI 用 397 个果实填满了整个棋盘', winMsg);
  check('标题同步：通关 · 得分 397 · 贪吃蛇', fin.title === '通关 · 得分 397 · 贪吃蛇', fin.title);
  check('AI 成绩计入最高分', fin.best === 397 && fin.lsBest === '397');
  const full = await page.evaluate((n) => {
    const cv = document.getElementById('board');
    const g = cv.getContext('2d');
    const W = cv.width;
    const cell = W / n;
    const d = g.getImageData(0, 0, W, W).data;
    let empty = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (Math.floor((y + 0.5) * cell) * W + Math.floor((x + 0.5) * cell)) * 4;
        if (d[i + 1] < 90) empty++;
      }
    }
    return empty;
  }, N);
  check('像素确认 400 格全部被蛇身占据', full === 0, `空格 ${full}`);
  await checkLayout(page, env, '通关面板');
  if (pausedSeen) console.log(`  · 提示：期间检测到 ${pausedSeen} 次自动暂停（窗口失焦），已恢复`);

  check('浏览器控制台 0 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

async function runFileProtocol(browser) {
  console.log('\n■ file:// 直接打开');
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  const url = pathToFileURL(path.join(ROOT, 'index.html')).href;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#panelStart:not([hidden])');
  check('file:// 加载成功并显示开始界面', await page.isVisible('#btnStart'), url);
  check('file:// 下 ai.js 已加载', await page.evaluate(() => typeof window.SnakeAI === 'object'));
  await page.keyboard.press('Enter');
  await waitState(page, 'playing');
  const env = { input: 'keyboard' };
  const st = await autoPlay(page, env, 3, 90000);
  check('file:// 下可正常游玩（自动游玩达到 3 分）', st.maxScore >= 3, `死亡 ${st.deaths} 次`);
  check('file:// 下控制台 0 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

async function main() {
  const { chromium } = loadPlaywright();
  const srv = await createStaticServer({ root: ROOT, port: 0 });
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const started = Date.now();
  console.log(`静态服务器：${srv.url}`);
  const envs = [
    { name: '桌面', viewport: { width: 1280, height: 820 }, dpr: 1, touch: false, input: 'keyboard', expectDpad: false, aiDifficulty: 'normal' },
    { name: '手机竖屏', viewport: { width: 390, height: 844 }, dpr: 3, touch: true, input: 'dpad', expectDpad: true, aiDifficulty: 'insane' },
    { name: '手机横屏', viewport: { width: 844, height: 390 }, dpr: 3, touch: true, input: 'swipe', expectDpad: false, aiDifficulty: 'hard' },
    { name: '小屏 320', viewport: { width: 320, height: 568 }, dpr: 2, touch: true, input: 'dpad', expectDpad: true, aiDifficulty: 'easy' }
  ];
  try {
    const only = process.env.ONLY;
    for (const env of envs) {
      if (only && !env.name.includes(only)) continue;
      try {
        await runEnv(browser, srv.url, env);
      } catch (err) {
        check(`${env.name} 流程异常`, false, err.message.split('\n')[0]);
      }
    }
    if (!only || only === 'file') {
      try {
        await runFileProtocol(browser);
      } catch (err) {
        check('file:// 流程异常', false, err.message.split('\n')[0]);
      }
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  console.log(`\n合计 ${total} 项断言，${total - failed} 通过，${failed} 失败（${((Date.now() - started) / 1000).toFixed(0)}s）`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

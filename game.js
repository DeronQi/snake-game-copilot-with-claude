/*!
 * game.js —— 贪吃蛇：界面 / 渲染 / 输入 / 音效 / PWA 注册
 * 规则与 AI 来自 ai.js（window.SnakeAI），与无头模拟脚本共用同一份代码。
 */
(function () {
  'use strict';

  const Core = window.SnakeAI;
  if (!Core) {
    document.body.textContent = '加载失败：缺少 ai.js';
    return;
  }
  const { COLS, ROWS, DIFFICULTIES, DIFFICULTY_ORDER, OPPOSITE, DIRS } = Core;

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------
  const STORE_KEYS = Object.freeze({
    best: 'snake.best',
    difficulty: 'snake.difficulty',
    muted: 'snake.muted',
    aiSpeed: 'snake.aiSpeed'
  });
  /** AI 演示倍速：在当前难度 / 等级的步速基础上加速；MAX 为固定步频上限 */
  const AI_SPEEDS = Object.freeze([
    { label: '×1', mult: 1 },
    { label: '×4', mult: 4 },
    { label: '×16', mult: 16 },
    { label: '×64', mult: 64 },
    { label: 'MAX', mult: Infinity }
  ]);
  /** MAX 档步频（步/秒）。AI 平均约 3.3 万步通关 → 约 24 秒（见 tools/simulate-ai.cjs） */
  const AI_MAX_SPS = 1400;
  const DPR_CAP = 2.5;
  const MAX_TURN_QUEUE = 2;
  const KEY_DIRS = Object.freeze({
    arrowup: 'up', w: 'up',
    arrowdown: 'down', s: 'down',
    arrowleft: 'left', a: 'left',
    arrowright: 'right', d: 'right'
  });

  // 颜色（verify.cjs 会按这些颜色做像素识别）
  const COLOR_TAIL = [16, 110, 78];
  const COLOR_NECK = [88, 255, 170];
  const COLOR_HEAD = 'rgb(214,255,240)';
  const COLOR_HEAD_DEAD = 'rgb(255,179,71)';
  const COLOR_FOOD = '#ff3b5c';

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const ui = {
    stage: $('stage'),
    wrap: $('boardWrap'),
    canvas: $('board'),
    overlay: $('overlay'),
    panels: { start: $('panelStart'), pause: $('panelPause'), over: $('panelOver'), win: $('panelWin') },
    score: $('score'),
    best: $('best'),
    speed: $('speed'),
    statScore: $('statScore'),
    statBest: $('statBest'),
    statSpeed: $('statSpeed'),
    btnAI: $('btnAI'),
    btnSound: $('btnSound'),
    btnFull: $('btnFull'),
    btnPause: $('btnPause'),
    aiBar: $('aiBar'),
    btnAISpeed: $('btnAISpeed'),
    diffSeg: $('diffSeg'),
    diffHint: $('diffHint'),
    startBest: $('startBest'),
    overReason: $('overReason'),
    overScore: $('overScore'),
    overBest: $('overBest'),
    overRecord: $('overRecord'),
    winMsg: $('winMsg'),
    winScore: $('winScore'),
    winBest: $('winBest'),
    dpad: $('dpad')
  };
  const ctx = ui.canvas.getContext('2d');
  const bgLayer = document.createElement('canvas');

  // ---------------------------------------------------------------------------
  // 持久化（file:// 或隐私模式下 localStorage 可能抛错，统一兜底）
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const v = window.localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch (e) {
        /* 存储不可用时静默忽略 */
      }
    }
  };

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionQuery && motionQuery.matches);

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const ai = Core.createAI(COLS, ROWS);
  let difficulty = DIFFICULTIES[store.get(STORE_KEYS.difficulty, 'normal')] ? store.get(STORE_KEYS.difficulty, 'normal') : 'normal';
  let best = Math.max(0, parseInt(store.get(STORE_KEYS.best, '0'), 10) || 0);
  let muted = store.get(STORE_KEYS.muted, '0') === '1';
  let aiSpeedIdx = Math.min(AI_SPEEDS.length - 1, Math.max(0, parseInt(store.get(STORE_KEYS.aiSpeed, '0'), 10) || 0));
  let aiMode = false;
  let mode = 'ready'; // ready | playing | paused | over | won
  let game = Core.createGame();
  const turnQueue = [];
  let acc = 0;
  let lastFrame = performance.now();
  let hudDirty = true;
  let newRecord = false;
  let lastInputKeyboard = false;
  let lastScoreShown = -1;
  let lastLevelShown = -1;
  const fx = { flash: 0, shake: 0, rings: [] };
  const view = { side: 0, dpr: 1 };

  // ---------------------------------------------------------------------------
  // 音效：WebAudio 合成，首次用户交互后才创建 AudioContext
  // ---------------------------------------------------------------------------
  const sound = (() => {
    let actx = null;
    let lastEat = 0;

    function unlock() {
      if (actx) {
        if (actx.state === 'suspended') actx.resume().catch(() => {});
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        actx = new AC();
      } catch (e) {
        actx = null;
      }
    }

    function tone(freq, at, dur, type, vol, endFreq) {
      if (muted || !actx || actx.state !== 'running') return;
      const t0 = actx.currentTime + at;
      const osc = actx.createOscillator();
      const gain = actx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(actx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    return {
      unlock,
      eat() {
        const now = performance.now();
        if (now - lastEat < 70) return; // AI 高速时节流，避免噪音
        lastEat = now;
        tone(660, 0, 0.09, 'square', 0.045, 1040);
      },
      level() {
        tone(880, 0, 0.08, 'triangle', 0.05);
        tone(1320, 0.07, 0.12, 'triangle', 0.05);
      },
      die() {
        tone(330, 0, 0.5, 'sawtooth', 0.07, 55);
        tone(160, 0.05, 0.45, 'square', 0.04, 40);
      },
      start() {
        [523, 659, 784].forEach((f, i) => tone(f, i * 0.07, 0.11, 'triangle', 0.06));
      },
      win() {
        [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 0.2, 'triangle', 0.07));
      }
    };
  })();

  function vibrate(pattern) {
    if (muted || typeof navigator.vibrate !== 'function') return;
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      /* 部分浏览器禁止 */
    }
  }

  // ---------------------------------------------------------------------------
  // 布局：棋盘始终为正方形，取容器可用空间 min(宽, 高)
  // ---------------------------------------------------------------------------
  function layout() {
    const w = ui.stage.clientWidth;
    const h = ui.stage.clientHeight;
    let side = Math.floor(Math.min(w, h));
    if (side >= COLS * 4) side = Math.floor(side / COLS) * COLS; // 对齐整数格，网格更清晰
    side = Math.max(0, side);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (side === view.side && dpr === view.dpr) return;
    view.side = side;
    view.dpr = dpr;
    ui.wrap.style.width = side + 'px';
    ui.wrap.style.height = side + 'px';
    const px = Math.max(COLS, Math.round((side * dpr) / COLS) * COLS);
    ui.canvas.width = px;
    ui.canvas.height = px;
    buildBackground();
    render(performance.now());
  }

  /** 预渲染背景层：棋盘格 + 网格线 + 暗角 */
  function buildBackground() {
    const W = ui.canvas.width;
    const cell = W / COLS;
    bgLayer.width = W;
    bgLayer.height = W;
    const g = bgLayer.getContext('2d');
    g.fillStyle = '#060b16';
    g.fillRect(0, 0, W, W);
    g.fillStyle = 'rgba(120,160,255,0.028)';
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if ((x + y) % 2 === 0) g.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    g.strokeStyle = 'rgba(120,180,255,0.07)';
    g.lineWidth = Math.max(1, view.dpr * 0.6);
    g.beginPath();
    for (let i = 1; i < COLS; i++) {
      const p = Math.round(i * cell) + 0.5;
      g.moveTo(p, 0);
      g.lineTo(p, W);
      g.moveTo(0, p);
      g.lineTo(W, p);
    }
    g.stroke();
    const vg = g.createRadialGradient(W / 2, W / 2, W * 0.25, W / 2, W / 2, W * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, W);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function mix(a, b, t) {
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  }

  function render(now) {
    const W = ui.canvas.width;
    if (!W) return;
    const cell = W / COLS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, W);
    if (fx.shake > 0 && !reducedMotion()) {
      const m = cell * 0.35 * fx.shake;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }
    ctx.drawImage(bgLayer, 0, 0);
    drawFood(now, cell);
    drawRings(cell);
    drawSnake(cell);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (fx.flash > 0) {
      ctx.fillStyle = `rgba(255,40,70,${(reducedMotion() ? 0.2 : 0.45) * fx.flash})`;
      ctx.fillRect(0, 0, W, W);
    }
  }

  const cx = (i, cell) => ((i % COLS) + 0.5) * cell;
  const cy = (i, cell) => (((i / COLS) | 0) + 0.5) * cell;

  function drawFood(now, cell) {
    if (game.food < 0) return;
    const x = cx(game.food, cell);
    const y = cy(game.food, cell);
    const pulse = reducedMotion() ? 0 : Math.sin(now / 170) * 0.045;
    const r = cell * (0.33 + pulse);
    ctx.save();
    ctx.shadowColor = 'rgba(255,59,92,0.9)';
    ctx.shadowBlur = cell * 0.6;
    ctx.fillStyle = COLOR_FOOD;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // 高光（偏离中心，不影响像素识别）
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(x - r * 0.38, y - r * 0.38, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    // 小叶子
    ctx.fillStyle = '#4fd18b';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.35, y - r * 0.98, r * 0.32, r * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRings(cell) {
    for (const ring of fx.rings) {
      const p = ring.t / 450;
      ctx.strokeStyle = `rgba(255,214,120,${(1 - p) * 0.6})`;
      ctx.lineWidth = cell * 0.08;
      ctx.beginPath();
      ctx.arc(cx(ring.cell, cell), cy(ring.cell, cell), cell * (0.4 + 0.9 * p), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawSnake(cell) {
    const s = game.snake;
    const n = s.length;
    if (!n) return;
    // 1) 整体光晕：一条带阴影的粗折线（只画一次，开销小）
    if (n > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = cell * 0.6;
      ctx.strokeStyle = 'rgba(60,255,170,0.25)';
      ctx.shadowColor = 'rgba(57,255,159,0.6)';
      ctx.shadowBlur = cell * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx(s[0], cell), cy(s[0], cell));
      for (let i = 1; i < n; i++) ctx.lineTo(cx(s[i], cell), cy(s[i], cell));
      ctx.stroke();
      ctx.restore();
    }
    // 2) 逐节绘制：尾暗 → 头亮，每节与靠头一侧的邻节之间画连接桥
    const pad = cell * 0.1;
    const size = cell - pad * 2;
    const radius = cell * 0.3;
    const bridge = cell * 0.76;
    for (let i = n - 1; i >= 1; i--) {
      const t = n <= 2 ? 1 : 1 - (i - 1) / (n - 2);
      ctx.fillStyle = mix(COLOR_TAIL, COLOR_NECK, t);
      const ax = cx(s[i], cell);
      const ay = cy(s[i], cell);
      const bx = cx(s[i - 1], cell);
      const by = cy(s[i - 1], cell);
      if (ay === by) ctx.fillRect(Math.min(ax, bx), ay - bridge / 2, Math.abs(bx - ax), bridge);
      else ctx.fillRect(ax - bridge / 2, Math.min(ay, by), bridge, Math.abs(by - ay));
      roundRectPath(ctx, ax - size / 2, ay - size / 2, size, size, radius);
      ctx.fill();
    }
    // 3) 蛇头 + 眼睛
    const hx = cx(s[0], cell);
    const hy = cy(s[0], cell);
    const dead = mode === 'over';
    ctx.save();
    ctx.shadowColor = dead ? 'rgba(255,150,60,0.9)' : 'rgba(150,255,210,0.9)';
    ctx.shadowBlur = cell * 0.5;
    ctx.fillStyle = dead ? COLOR_HEAD_DEAD : COLOR_HEAD;
    const hs = cell - pad * 1.4;
    roundRectPath(ctx, hx - hs / 2, hy - hs / 2, hs, hs, cell * 0.34);
    ctx.fill();
    ctx.restore();
    const d = DIRS[game.dir];
    const px = -d.y;
    const py = d.x;
    ctx.fillStyle = '#062014';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hx + d.x * cell * 0.16 + px * cell * 0.21 * side, hy + d.y * cell * 0.16 + py * cell * 0.21 * side, cell * 0.085, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // HUD / 标题 / 面板
  // ---------------------------------------------------------------------------
  function setText(el, text) {
    const s = String(text);
    if (el.textContent !== s) el.textContent = s;
  }

  function bump(el) {
    if (reducedMotion() || (aiMode && aiSpeedIdx > 1)) return;
    el.classList.remove('pop');
    void el.offsetWidth; // 强制重排以重启动画
    el.classList.add('pop');
  }

  function fastAI() {
    return aiMode && aiSpeedIdx > 1;
  }

  function updateHUD() {
    hudDirty = false;
    const score = game.score;
    const level = Core.levelForScore(score);
    if (score !== lastScoreShown) {
      if (score > lastScoreShown && lastScoreShown >= 0) bump(ui.statScore);
      lastScoreShown = score;
    }
    if (level !== lastLevelShown) {
      if (level > lastLevelShown && lastLevelShown >= 0) bump(ui.statSpeed);
      lastLevelShown = level;
    }
    setText(ui.score, score);
    setText(ui.best, best);
    setText(ui.startBest, best);
    setText(ui.speed, `${level} 级`);
    ui.statSpeed.title = `${DIFFICULTIES[difficulty].label} · ${Core.intervalFor(difficulty, level)} 毫秒/步`;

    const paused = mode === 'paused';
    setText(ui.btnPause, paused ? '▶' : '⏸');
    ui.btnPause.setAttribute('aria-pressed', String(paused));
    ui.btnPause.setAttribute('aria-label', paused ? '继续' : '暂停');
    ui.btnPause.disabled = !(mode === 'playing' || mode === 'paused');

    ui.btnAI.setAttribute('aria-pressed', String(aiMode));
    ui.btnAI.setAttribute('aria-label', aiMode ? 'AI 演示：开（点击关闭）' : 'AI 演示：关（点击开启）');

    setText(ui.btnSound, muted ? '🔇' : '🔊');
    ui.btnSound.setAttribute('aria-pressed', String(!muted));
    ui.btnSound.setAttribute('aria-label', muted ? '声音：关' : '声音：开');

    ui.aiBar.hidden = !(aiMode && (mode === 'playing' || mode === 'paused'));
    const sp = AI_SPEEDS[aiSpeedIdx].label;
    setText(ui.btnAISpeed, sp);
    ui.btnAISpeed.setAttribute('aria-label', `AI 演示速度：${sp}，点击切换`);

    let title;
    if (mode === 'won') title = `通关 · 得分 ${score} · 贪吃蛇`;
    else if (mode === 'paused') title = `已暂停 · 得分 ${score} · 贪吃蛇`;
    else title = `得分 ${score} · 贪吃蛇`;
    if (document.title !== title) document.title = title;
  }

  function updateDifficultyUI() {
    for (const btn of ui.diffSeg.querySelectorAll('[data-diff]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.diff === difficulty));
    }
    const d = DIFFICULTIES[difficulty];
    setText(ui.diffHint, `${d.label} · ${d.base}→${d.min} 毫秒/步`);
    hudDirty = true;
  }

  function setDifficulty(id) {
    if (!DIFFICULTIES[id]) return;
    difficulty = id;
    store.set(STORE_KEYS.difficulty, id);
    updateDifficultyUI();
  }

  function overlayVisible() {
    return !ui.overlay.hidden;
  }

  function showPanel(name) {
    ui.overlay.hidden = false;
    for (const key of Object.keys(ui.panels)) ui.panels[key].hidden = key !== name;
    if (lastInputKeyboard) {
      const primary = ui.panels[name].querySelector('[data-autofocus]');
      if (primary) primary.focus({ preventScroll: true });
    }
    hudDirty = true;
  }

  function hideOverlay() {
    if (ui.overlay.contains(document.activeElement)) document.activeElement.blur();
    ui.overlay.hidden = true;
    for (const key of Object.keys(ui.panels)) ui.panels[key].hidden = true;
  }

  function setMode(m) {
    mode = m;
    document.body.dataset.state = m;
    updateHUD(); // 状态切换时同步刷新 HUD / 标题，避免与 data-state 出现一帧不一致
  }

  // ---------------------------------------------------------------------------
  // 游戏流程
  // ---------------------------------------------------------------------------
  function newGame(useAI) {
    aiMode = !!useAI;
    game = Core.createGame();
    turnQueue.length = 0;
    acc = 0;
    newRecord = false;
    fx.flash = 0;
    fx.shake = 0;
    fx.rings.length = 0;
    lastScoreShown = -1;
    lastLevelShown = -1;
    setMode('playing');
    hideOverlay();
    sound.start();
  }

  function pause() {
    if (mode !== 'playing') return;
    setMode('paused');
    turnQueue.length = 0;
    showPanel('pause');
  }

  function resume() {
    if (mode !== 'paused') return;
    setMode('playing');
    acc = 0;
    lastFrame = performance.now();
    hideOverlay();
  }

  function togglePause() {
    if (mode === 'playing') pause();
    else if (mode === 'paused') resume();
  }

  function showMenu() {
    aiMode = false;
    setMode('ready');
    showPanel('start');
  }

  /** 🤖 开关：开启时若蛇身满足 AI 不变式就直接接管，否则开一局新的 AI 演示 */
  function toggleAI() {
    if (aiMode) {
      aiMode = false;
      turnQueue.length = 0;
      updateHUD();
      return;
    }
    if ((mode === 'playing' || mode === 'paused') && ai.isOrdered(game)) {
      aiMode = true;
      turnQueue.length = 0;
      updateHUD();
      return;
    }
    newGame(true);
  }

  function cycleAISpeed() {
    aiSpeedIdx = (aiSpeedIdx + 1) % AI_SPEEDS.length;
    store.set(STORE_KEYS.aiSpeed, aiSpeedIdx);
    acc = 0;
    updateHUD();
  }

  /** 转向队列：最多缓存 2 次，忽略与上一个方向相同或 180° 相反的输入 */
  function queueTurn(dir) {
    if (mode !== 'playing' || aiMode) return;
    const last = turnQueue.length ? turnQueue[turnQueue.length - 1] : game.dir;
    if (dir === last || OPPOSITE[dir] === last) return;
    if (turnQueue.length >= MAX_TURN_QUEUE) return;
    turnQueue.push(dir);
  }

  function stepInterval() {
    const base = Core.intervalFor(difficulty, Core.levelForScore(game.score));
    if (!aiMode) return base;
    return Math.max(1000 / AI_MAX_SPS, base / AI_SPEEDS[aiSpeedIdx].mult);
  }

  function tick() {
    const dir = aiMode ? ai.decide(game) : turnQueue.length ? turnQueue.shift() : game.dir;
    const res = Core.step(game, dir);
    if (res.ate) onEat(res);
    if (res.won) onWin();
    else if (res.died) onDie();
  }

  function onEat(res) {
    // 刷新纪录的瞬间立即落盘（中途重开 / 刷新都不会丢）
    if (game.score > best) {
      best = game.score;
      newRecord = true;
      store.set(STORE_KEYS.best, best);
    }
    if (!fastAI()) {
      sound.eat();
      if (!aiMode) vibrate(18);
      if (!reducedMotion()) fx.rings.push({ cell: res.cell, t: 0 });
      if (res.levelUp) sound.level();
    }
    hudDirty = true;
  }

  function onDie() {
    setMode('over');
    fx.flash = 1;
    fx.shake = reducedMotion() ? 0 : 1;
    sound.die();
    vibrate(400);
    setText(ui.overReason, game.deathReason === 'wall' ? '撞墙了' : '咬到自己了');
    setText(ui.overScore, game.score);
    setText(ui.overBest, best);
    ui.overRecord.hidden = !newRecord;
    showPanel('over');
  }

  function onWin() {
    setMode('won');
    fx.rings.length = 0;
    sound.win();
    vibrate([60, 40, 60, 40, 160]);
    setText(
      ui.winMsg,
      aiMode ? `AI 通关！AI 用 ${game.score} 个果实填满了整个棋盘` : `太强了！你用 ${game.score} 个果实填满了整个棋盘`
    );
    setText(ui.winScore, game.score);
    setText(ui.winBest, best);
    showPanel('win');
  }

  // ---------------------------------------------------------------------------
  // 主循环：固定步长累加器，渲染与逻辑解耦（AI 高倍速时一帧可推进多步）
  // ---------------------------------------------------------------------------
  function frame(now) {
    window.requestAnimationFrame(frame);
    const dt = Math.min(250, Math.max(0, now - lastFrame));
    lastFrame = now;
    if (mode === 'playing') {
      acc += dt;
      const maxSteps = aiMode ? 600 : 3;
      let steps = 0;
      while (mode === 'playing') {
        const iv = stepInterval();
        if (acc < iv) break;
        acc -= iv;
        tick();
        if (++steps >= maxSteps) {
          acc = 0;
          break;
        }
      }
    }
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - dt / 500);
    if (fx.shake > 0) fx.shake = Math.max(0, fx.shake - dt / 450);
    if (fx.rings.length) {
      for (const r of fx.rings) r.t += dt;
      while (fx.rings.length && fx.rings[0].t >= 450) fx.rings.shift();
    }
    if (hudDirty) updateHUD();
    render(now);
  }

  // ---------------------------------------------------------------------------
  // 输入：键盘
  // ---------------------------------------------------------------------------
  function startOrRestart() {
    if (mode === 'ready' || mode === 'over' || mode === 'won') newGame(false);
  }

  function onKeyDown(e) {
    lastInputKeyboard = true;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    // 弹层里的按钮获得焦点时，Enter / 空格交给按钮自身处理
    if ((key === 'enter' || key === ' ') && btn && overlayVisible() && ui.overlay.contains(btn)) return;

    let handled = true;
    if (KEY_DIRS[key]) {
      queueTurn(KEY_DIRS[key]);
    } else if (key === ' ' || key === 'spacebar') {
      if (mode === 'playing' || mode === 'paused') togglePause();
      else startOrRestart();
    } else if (key === 'p' || key === 'escape') {
      if (key === 'escape' && mode !== 'playing') handled = false;
      else togglePause();
    } else if (key === 'enter') {
      if (mode === 'paused') resume();
      else startOrRestart();
    } else if (key === 'r') {
      newGame(aiMode);
    } else if (key === 'm') {
      toggleMute();
    } else if (key === 'f') {
      toggleFullscreen();
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // 输入：鼠标拖动 / 触摸滑动（Pointer Events 统一处理）
  // ---------------------------------------------------------------------------
  let swipe = null;

  function onPointerDown(e) {
    lastInputKeyboard = false;
    if (e.pointerType === 'touch') document.body.classList.add('touch');
    if (overlayVisible() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
    // 关键：遮罩可见时绝不 setPointerCapture，否则弹层按钮收不到点击
    if (!overlayVisible()) {
      try {
        ui.canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    const threshold = Math.max(14, (view.side / COLS) * 0.6);
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    queueTurn(dir);
    // 以当前位置为新起点，按住不放可连续转向
    swipe.x = e.clientX;
    swipe.y = e.clientY;
  }

  function onPointerUp(e) {
    if (!swipe || e.pointerId !== swipe.id) return;
    swipe = null;
    try {
      if (ui.canvas.hasPointerCapture(e.pointerId)) ui.canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------------------
  // 全屏 / 静音
  // ---------------------------------------------------------------------------
  const rootEl = document.documentElement;
  const canFullscreen = !!(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen);
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  function toggleFullscreen() {
    if (!canFullscreen) return;
    let p;
    if (fullscreenElement()) {
      p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      p = (rootEl.requestFullscreen || rootEl.webkitRequestFullscreen).call(rootEl);
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  function syncFullscreenButton() {
    const on = !!fullscreenElement();
    ui.btnFull.setAttribute('aria-pressed', String(on));
    ui.btnFull.setAttribute('aria-label', on ? '退出全屏' : '全屏');
  }

  function toggleMute() {
    muted = !muted;
    store.set(STORE_KEYS.muted, muted ? '1' : '0');
    updateHUD();
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------
  function onClick(el, fn) {
    el.addEventListener('click', (e) => {
      fn(e);
      // 鼠标 / 触摸点击后移除焦点，避免之后按空格误触这个按钮
      if (e.detail > 0 && !ui.overlay.contains(el)) el.blur();
    });
  }

  function bindEvents() {
    // 首次用户交互后才创建 / 恢复 AudioContext
    window.addEventListener('pointerdown', sound.unlock, { capture: true, passive: true });
    window.addEventListener('keydown', sound.unlock, { capture: true });
    window.addEventListener('keydown', onKeyDown);

    ui.canvas.addEventListener('pointerdown', onPointerDown);
    ui.canvas.addEventListener('pointermove', onPointerMove);
    ui.canvas.addEventListener('pointerup', onPointerUp);
    ui.canvas.addEventListener('pointercancel', onPointerUp);
    ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointerdown', (e) => {
      lastInputKeyboard = false;
      if (e.pointerType === 'touch') document.body.classList.add('touch');
    }, { capture: true, passive: true });

    onClick(ui.btnAI, toggleAI);
    onClick(ui.btnSound, toggleMute);
    onClick(ui.btnFull, toggleFullscreen);
    onClick(ui.btnPause, togglePause);
    onClick(ui.btnAISpeed, cycleAISpeed);

    for (const btn of ui.diffSeg.querySelectorAll('[data-diff]')) {
      onClick(btn, () => setDifficulty(btn.dataset.diff));
    }
    onClick($('btnStart'), () => newGame(false));
    onClick($('btnStartAI'), () => newGame(true));
    onClick($('btnResume'), resume);
    onClick($('btnRestart'), () => newGame(aiMode));
    onClick($('btnRetry'), () => newGame(false));
    onClick($('btnOverMenu'), showMenu);
    onClick($('btnOverAI'), () => newGame(true));
    onClick($('btnWinRetry'), () => newGame(false));
    onClick($('btnWinMenu'), showMenu);
    onClick($('btnWinAI'), () => newGame(true));

    // 屏幕方向键：pointerdown 立即响应（比 click 少约 100ms 延迟）
    for (const btn of ui.dpad.querySelectorAll('button')) {
      const act = () => {
        if (btn.dataset.dir) queueTurn(btn.dataset.dir);
        else if (mode === 'playing' || mode === 'paused') togglePause();
        else startOrRestart();
      };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        act();
      });
      const release = () => btn.classList.remove('pressed');
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
      // 键盘（Tab 聚焦后回车）触发的 click 没有指针事件
      btn.addEventListener('click', (e) => {
        if (e.detail === 0) act();
      });
    }

    // 切到后台 / 窗口失焦自动暂停
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause();
      lastFrame = performance.now();
    });
    window.addEventListener('blur', pause);
    window.addEventListener('pagehide', pause);

    document.addEventListener('fullscreenchange', syncFullscreenButton);
    document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
    if (!canFullscreen) {
      ui.btnFull.disabled = true;
      ui.btnFull.title = '当前浏览器不支持全屏';
    }

    // 尺寸变化：ResizeObserver 实时重算棋盘
    if (typeof ResizeObserver === 'function') new ResizeObserver(layout).observe(ui.stage);
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', layout);

    // 触屏检测：粗指针设备显示方向键
    const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
    const applyTouch = () => {
      if (coarse && coarse.matches) document.body.classList.add('touch');
    };
    applyTouch();
    if (coarse && coarse.addEventListener) coarse.addEventListener('change', applyTouch);
  }

  // ---------------------------------------------------------------------------
  // PWA：注册 Service Worker；已有旧 SW 时新 SW 接管后自动刷新一次
  // ---------------------------------------------------------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return; // 首次安装不刷新
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {
        /* 注册失败不影响游戏 */
      });
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  bindEvents();
  updateDifficultyUI();
  syncFullscreenButton();
  setMode('ready');
  showPanel('start');
  layout();
  updateHUD();
  window.requestAnimationFrame((t) => {
    lastFrame = t;
    frame(t);
  });
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker);
})();

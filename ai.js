/*!
 * ai.js —— 贪吃蛇「核心规则 + 保证通关的 AI」
 *
 * UMD 风格：
 *   - 浏览器：<script src="ai.js"> 后挂到 window.SnakeAI
 *   - Node：const SnakeAI = require('./ai.js') 直接使用（tools/ 下的验证脚本依赖它）
 *
 * 游戏规则（createGame / step / spawnFood）也放在这里，
 * 这样浏览器里的游戏与无头模拟脚本跑的是「同一份」规则代码，保证结论可信。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.SnakeAI = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------
  var COLS = 20;
  var ROWS = 20;
  var CELLS = COLS * ROWS;
  var INITIAL_LENGTH = 3;
  var POINTS_PER_LEVEL = 4;
  var MAX_LEVEL = 10;

  /** 四档难度：只影响速度（毫秒/步），base 为 1 级，min 为 10 级 */
  var DIFFICULTIES = Object.freeze({
    easy: Object.freeze({ id: 'easy', label: '简单', base: 230, min: 150 }),
    normal: Object.freeze({ id: 'normal', label: '普通', base: 150, min: 78 }),
    hard: Object.freeze({ id: 'hard', label: '困难', base: 105, min: 58 }),
    insane: Object.freeze({ id: 'insane', label: '疯狂', base: 70, min: 38 })
  });
  var DIFFICULTY_ORDER = Object.freeze(['easy', 'normal', 'hard', 'insane']);

  var DIRS = Object.freeze({
    up: Object.freeze({ x: 0, y: -1 }),
    down: Object.freeze({ x: 0, y: 1 }),
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 })
  });
  var DIR_NAMES = Object.freeze(['up', 'right', 'down', 'left']);
  var OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

  // ---------------------------------------------------------------------------
  // 速度 / 等级
  // ---------------------------------------------------------------------------
  /** 每 4 分升 1 级，最高 10 级 */
  function levelForScore(score) {
    return Math.min(MAX_LEVEL, 1 + Math.floor(score / POINTS_PER_LEVEL));
  }

  /** 线性插值：1 级 = base，10 级 = min */
  function intervalFor(difficulty, level) {
    var d = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
    var lv = Math.max(1, Math.min(MAX_LEVEL, level | 0));
    return Math.round(d.base - (d.base - d.min) * (lv - 1) / (MAX_LEVEL - 1));
  }

  // ---------------------------------------------------------------------------
  // 可复现随机数（模拟脚本用）
  // ---------------------------------------------------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // 核心规则
  // 蛇用「格子下标数组」表示：idx = y * cols + x，snake[0] 为蛇头。
  // occupied 为占用位图，O(1) 判断碰撞。
  // ---------------------------------------------------------------------------
  function createGame(opts) {
    opts = opts || {};
    var cols = opts.cols || COLS;
    var rows = opts.rows || ROWS;
    var total = cols * rows;
    var s = {
      cols: cols,
      rows: rows,
      total: total,
      rng: opts.rng || Math.random,
      snake: [],
      occupied: new Uint8Array(total),
      dir: 'right',
      food: -1,
      score: 0,
      steps: 0,
      over: false,
      won: false,
      deathReason: null
    };
    // 初始 3 节，位于中间行，向右出发（头在右）
    var y = Math.floor(rows / 2);
    var hx = Math.max(INITIAL_LENGTH, Math.floor(cols / 4));
    for (var i = 0; i < INITIAL_LENGTH; i++) {
      var idx = y * cols + (hx - i);
      s.snake.push(idx);
      s.occupied[idx] = 1;
    }
    spawnFood(s);
    return s;
  }

  /** 在所有空格中等概率挑一个放果实；没有空格时返回 -1 */
  function spawnFood(s) {
    var free = s.total - s.snake.length;
    if (free <= 0) {
      s.food = -1;
      return -1;
    }
    var k = Math.floor(s.rng() * free);
    if (k >= free) k = free - 1;
    for (var i = 0; i < s.total; i++) {
      if (!s.occupied[i]) {
        if (k === 0) {
          s.food = i;
          return i;
        }
        k--;
      }
    }
    s.food = -1;
    return -1;
  }

  /**
   * 推进一步。dirName 为期望方向（180° 掉头会被忽略，保持原方向）。
   * 返回本步事件：{ ate, died, won, levelUp, cell }
   */
  function step(s, dirName) {
    var res = { ate: false, died: false, won: false, levelUp: false, cell: -1 };
    if (s.over) return res;
    if (dirName && DIRS[dirName] && OPPOSITE[dirName] !== s.dir) s.dir = dirName;
    var d = DIRS[s.dir];
    var head = s.snake[0];
    var nx = (head % s.cols) + d.x;
    var ny = ((head / s.cols) | 0) + d.y;
    if (nx < 0 || ny < 0 || nx >= s.cols || ny >= s.rows) {
      s.over = true;
      s.deathReason = 'wall';
      res.died = true;
      return res;
    }
    var ni = ny * s.cols + nx;
    res.cell = ni;
    var eating = ni === s.food;
    var tail = s.snake[s.snake.length - 1];
    // 不吃果实时尾巴会同时移走，所以允许头走进「当前尾巴」所在格
    if (s.occupied[ni] && !(ni === tail && !eating)) {
      s.over = true;
      s.deathReason = 'self';
      res.died = true;
      return res;
    }
    if (!eating) {
      s.snake.pop();
      s.occupied[tail] = 0;
    }
    s.snake.unshift(ni);
    s.occupied[ni] = 1;
    s.steps++;
    if (eating) {
      var before = levelForScore(s.score);
      s.score++;
      res.ate = true;
      res.levelUp = levelForScore(s.score) > before;
      if (s.snake.length >= s.total) {
        s.won = true;
        s.over = true;
        s.food = -1;
        res.won = true;
      } else {
        spawnFood(s);
      }
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // 哈密顿环
  //
  //   第 0 列从上往下走到底 → 第 1..cols-1 列在第 1..rows-1 行之间蛇形往返
  //   （奇数列向上、偶数列向下）→ 最后沿第 0 行向左走回 (0,0) 闭合。
  //
  //   例（6×4，箭头为每格走向环上的下一格）：
  //               ↓ ← ← ← ← ←      列数必须为偶数，最后一列（奇数列）
  //               ↓ → ↓ → ↓ ↑      才会向上走到第 1 行，再拐进第 0 行。
  //               ↓ ↑ ↓ ↑ ↓ ↑
  //               → ↑ → ↑ → ↑
  //
  // 每个格子得到唯一的「环序号」order[idx] ∈ [0, N)，path[order] = idx。
  // ---------------------------------------------------------------------------
  function buildCycle(cols, rows) {
    if (cols % 2 !== 0 || rows < 2 || cols < 2) {
      throw new Error('buildCycle 需要偶数列且行列 ≥ 2');
    }
    var total = cols * rows;
    var path = [];
    var x;
    var y;
    for (y = 0; y < rows; y++) path.push(y * cols);
    for (x = 1; x < cols; x++) {
      if (x % 2 === 1) {
        for (y = rows - 1; y >= 1; y--) path.push(y * cols + x);
      } else {
        for (y = 1; y < rows; y++) path.push(y * cols + x);
      }
    }
    for (x = cols - 1; x >= 1; x--) path.push(x);
    var order = new Int32Array(total);
    for (var i = 0; i < total; i++) order[path[i]] = i;
    return { path: Int32Array.from(path), order: order };
  }

  /** 校验：覆盖每个格子恰好一次，且相邻序号（含首尾）在网格上相邻 */
  function verifyCycle(cycle, cols, rows) {
    var total = cols * rows;
    if (cycle.path.length !== total) return false;
    var seen = new Uint8Array(total);
    for (var i = 0; i < total; i++) {
      var a = cycle.path[i];
      var b = cycle.path[(i + 1) % total];
      if (seen[a]) return false;
      seen[a] = 1;
      var dx = Math.abs((a % cols) - (b % cols));
      var dy = Math.abs(((a / cols) | 0) - ((b / cols) | 0));
      if (dx + dy !== 1) return false;
    }
    return true;
  }

  function dirBetween(a, b, cols) {
    var dx = (b % cols) - (a % cols);
    var dy = ((b / cols) | 0) - ((a / cols) | 0);
    if (dx === 1 && dy === 0) return 'right';
    if (dx === -1 && dy === 0) return 'left';
    if (dx === 0 && dy === 1) return 'down';
    if (dx === 0 && dy === -1) return 'up';
    return null;
  }

  // ---------------------------------------------------------------------------
  // AI：哈密顿环 + 安全抄近路
  //
  // 【不变式】从尾到头读蛇身，各节的环序号沿环「严格前进」且总跨度 < N。
  //   也就是说，整条蛇都落在环上的区间 [尾, 头] 内（区间里可以有空洞），
  //   区间 (头, 尾) —— 即头沿环往前到尾之间的所有格 —— 一定是空的。
  //
  // 【安全规则】设 step = (order[目标] - order[头]) mod N，
  //   gap = (order[尾] - order[头]) mod N。头只允许落到 step ≤ gap 的格：
  //   - step < gap：目标在 (头, 尾) 区间内，必空；新头仍在尾之前，不变式保持。
  //   - step = gap：目标就是尾巴，只有「这步不吃果实、尾巴会移走」时才允许。
  //   因此蛇永远不会追上自己的尾巴 → 永不咬到自己。
  //
  // 【不会卡死】沿环走 1 步（step = 1 ≤ gap）恒合法，所以每一步都有路可走。
  // 【必然通关】头每步沿环至少前进 1 格，果实总在环上某处；
  //   即便果实落在 [尾, 头] 的空洞里，尾巴前进后它也会进入 (头, 尾) 区间，
  //   最终一定被吃到 → 蛇长单调增长直到填满 N 格。
  //
  // 【抄近路】在所有合法候选里按
  //   [能直接吃到果实, 沿环到果实剩余步数, 曼哈顿距离, 环步长] 排序择优。
  //
  // 【门控】空地 < 蛇长 × 1.25 时禁止跳格（只允许沿环走 1 步或直接吃果实）：
  //   后期跳格会在蛇身后面留下零散空洞，果实一旦刷在空洞里就得绕一整圈，
  //   得不偿失。若门控后没有合法走法，则退回「不门控」版本重算，保证不卡死。
  // ---------------------------------------------------------------------------
  function createAI(cols, rows, options) {
    cols = cols || COLS;
    rows = rows || ROWS;
    options = options || {};
    var total = cols * rows;
    var cycle = buildCycle(cols, rows);
    var order = cycle.order;
    var path = cycle.path;
    var gateRatio = typeof options.gateRatio === 'number' ? options.gateRatio : 1.25;
    var useShortcuts = options.shortcuts !== false;

    /** 从格 a 沿环向前走到格 b 需要的步数 */
    function fwd(a, b) {
      var d = order[b] - order[a];
      return d < 0 ? d + total : d;
    }

    function better(a, b) {
      if (a.eat !== b.eat) return a.eat;
      if (a.remain !== b.remain) return a.remain < b.remain;
      if (a.manhattan !== b.manhattan) return a.manhattan < b.manhattan;
      return a.stepLen > b.stepLen;
    }

    function pick(s, gate) {
      var snake = s.snake;
      var len = snake.length;
      var head = snake[0];
      var tail = snake[len - 1];
      var hx = head % cols;
      var hy = (head / cols) | 0;
      var gap = fwd(head, tail);
      var food = s.food;
      var fx = food >= 0 ? food % cols : 0;
      var fy = food >= 0 ? (food / cols) | 0 : 0;
      var gated = gate && (total - len) < len * gateRatio;
      var best = null;
      for (var i = 0; i < DIR_NAMES.length; i++) {
        var name = DIR_NAMES[i];
        var d = DIRS[name];
        var nx = hx + d.x;
        var ny = hy + d.y;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        var ni = ny * cols + nx;
        var eat = ni === food;
        if (s.occupied[ni] && !(ni === tail && !eat)) continue;
        var stepLen = fwd(head, ni);
        if (stepLen === 0) continue;
        // 安全规则：不能越过尾巴；吃果实时尾巴不动，连尾巴格也不能踩
        if (eat ? stepLen >= gap : stepLen > gap) continue;
        // 门控：后期只允许沿环走 1 步或直接吃果实
        if (gated && !eat && stepLen !== 1) continue;
        var cand = {
          name: name,
          eat: eat,
          remain: food >= 0 ? fwd(ni, food) : 0,
          manhattan: food >= 0 ? Math.abs(nx - fx) + Math.abs(ny - fy) : 0,
          stepLen: stepLen
        };
        if (!best || better(cand, best)) best = cand;
      }
      return best;
    }

    /** 兜底：理论上不会走到这里（沿环 1 步恒合法），仅防御异常状态 */
    function fallback(s) {
      var head = s.snake[0];
      var tail = s.snake[s.snake.length - 1];
      for (var i = 0; i < DIR_NAMES.length; i++) {
        var name = DIR_NAMES[i];
        var nx = (head % cols) + DIRS[name].x;
        var ny = ((head / cols) | 0) + DIRS[name].y;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        var ni = ny * cols + nx;
        if (!s.occupied[ni] || (ni === tail && ni !== s.food)) return name;
      }
      return s.dir;
    }

    /** 给出下一步方向名 */
    function decide(s) {
      if (s.over) return s.dir;
      var head = s.snake[0];
      if (!useShortcuts) {
        // 纯绕环基线：永远走环上的下一格
        return dirBetween(head, path[(order[head] + 1) % total], cols) || fallback(s);
      }
      var best = pick(s, true) || pick(s, false);
      return best ? best.name : fallback(s);
    }

    /** 检查不变式：从尾到头环序号严格前进且总跨度 < N（AI 中途接管前用） */
    function isOrdered(s) {
      var snake = s.snake;
      var span = 0;
      for (var i = snake.length - 1; i > 0; i--) {
        var d = fwd(snake[i], snake[i - 1]);
        if (d === 0) return false;
        span += d;
        if (span >= total) return false;
      }
      return true;
    }

    return {
      cols: cols,
      rows: rows,
      order: order,
      path: path,
      decide: decide,
      isOrdered: isOrdered,
      distance: fwd
    };
  }

  return Object.freeze({
    COLS: COLS,
    ROWS: ROWS,
    CELLS: CELLS,
    INITIAL_LENGTH: INITIAL_LENGTH,
    POINTS_PER_LEVEL: POINTS_PER_LEVEL,
    MAX_LEVEL: MAX_LEVEL,
    DIFFICULTIES: DIFFICULTIES,
    DIFFICULTY_ORDER: DIFFICULTY_ORDER,
    DIRS: DIRS,
    DIR_NAMES: DIR_NAMES,
    OPPOSITE: OPPOSITE,
    levelForScore: levelForScore,
    intervalFor: intervalFor,
    mulberry32: mulberry32,
    createGame: createGame,
    spawnFood: spawnFood,
    step: step,
    buildCycle: buildCycle,
    verifyCycle: verifyCycle,
    dirBetween: dirBetween,
    createAI: createAI
  });
});

#!/usr/bin/env node
/*
 * tools/analyze-ai.cjs —— AI 策略效率分析
 *
 * 对比三条曲线（同一组随机种子）：
 *   1. 纯绕环基线：永远沿哈密顿环走下一格（绝对安全，但很慢）
 *   2. 本策略    ：哈密顿环 + 安全抄近路 + 门控（ai.js 默认配置）
 *   3. 曼哈顿下界：本策略每次果实刷新时，蛇头到果实的曼哈顿距离之和
 *                  （任何策略吃到该果实至少需要这么多步，作为理论下界参考）
 * 另附「不门控」变体，说明门控的作用。
 *
 * 并按果实序号分阶段统计每果实平均步数：前 25% / 中段 50% / 后 25%。
 *
 * 用法：node tools/analyze-ai.cjs [种子数，默认 10]
 */
'use strict';

const path = require('path');
const SnakeAI = require(path.join(__dirname, '..', 'ai.js'));

const SEEDS = Math.max(3, parseInt(process.argv[2], 10) || 10);
const FRUITS = SnakeAI.CELLS - SnakeAI.INITIAL_LENGTH; // 397

/** 跑一局，返回每个果实花费的步数，以及每个果实刷新时的曼哈顿距离 */
function run(seed, aiOptions) {
  const game = SnakeAI.createGame({ rng: SnakeAI.mulberry32(seed) });
  const ai = SnakeAI.createAI(SnakeAI.COLS, SnakeAI.ROWS, aiOptions);
  const perFruit = [];
  const manhattan = [];
  const cols = SnakeAI.COLS;
  const dist = (a, b) => Math.abs((a % cols) - (b % cols)) + Math.abs(((a / cols) | 0) - ((b / cols) | 0));
  manhattan.push(dist(game.snake[0], game.food));
  let last = 0;
  while (!game.over && game.steps < 1e6) {
    const res = SnakeAI.step(game, ai.decide(game));
    if (res.ate) {
      perFruit.push(game.steps - last);
      last = game.steps;
      if (!game.over) manhattan.push(dist(game.snake[0], game.food));
    }
  }
  if (!game.won) throw new Error(`seed ${seed} 未通关（${game.deathReason}）`);
  return { steps: game.steps, perFruit, manhattan };
}

function phaseStats(arrays) {
  const a = Math.floor(FRUITS * 0.25);
  const b = Math.floor(FRUITS * 0.75);
  const ranges = [
    ['前 25%', 0, a],
    ['中段 50%', a, b],
    ['后 25%', b, FRUITS],
    ['全程', 0, FRUITS]
  ];
  return ranges.map(([name, lo, hi]) => {
    let sum = 0;
    let n = 0;
    for (const arr of arrays) {
      for (let i = lo; i < hi; i++) {
        sum += arr[i];
        n++;
      }
    }
    return { name, range: `#${lo + 1}~#${hi}`, avg: sum / n };
  });
}

function main() {
  const seeds = Array.from({ length: SEEDS }, (_, i) => (0xa11ce + i * 2654435761) >>> 0);
  const variants = [
    { key: 'baseline', name: '纯绕环基线', opts: { shortcuts: false } },
    { key: 'nogate', name: '抄近路·不门控', opts: { gateRatio: -1 } },
    { key: 'strategy', name: '本策略', opts: {} }
  ];
  const results = {};
  for (const v of variants) {
    results[v.key] = seeds.map((s) => run(s, v.opts));
  }
  const lower = results.strategy.map((r) => ({ steps: r.manhattan.reduce((a, b) => a + b, 0), perFruit: r.manhattan }));

  const rows = [
    ['纯绕环基线', results.baseline],
    ['抄近路·不门控', results.nogate],
    ['本策略（门控 1.25）', results.strategy],
    ['曼哈顿下界', lower]
  ];

  console.log(`AI 效率分析：${SEEDS} 个种子，每局 ${FRUITS} 个果实（全部通关）\n`);
  console.log('方案                    总步数(平均)   最少     最多    相对基线   相对下界');
  console.log('-'.repeat(80));
  const baseAvg = results.baseline.reduce((a, r) => a + r.steps, 0) / SEEDS;
  const lowAvg = lower.reduce((a, r) => a + r.steps, 0) / SEEDS;
  for (const [name, list] of rows) {
    const steps = list.map((r) => r.steps);
    const avg = steps.reduce((a, b) => a + b, 0) / steps.length;
    console.log(
      `${name.padEnd(18 - (name.match(/[^\x00-\xff]/g) || []).length + 2)}${avg.toFixed(0).padStart(10)}  ${String(Math.min(...steps)).padStart(7)}  ${String(Math.max(...steps)).padStart(7)}  ${((avg / baseAvg) * 100).toFixed(1).padStart(7)}%  ${(avg / lowAvg).toFixed(2).padStart(7)}×`
    );
  }

  console.log('\n分阶段：每果实平均步数');
  const header = ['阶段', '果实区间', '纯绕环基线', '不门控', '本策略', '曼哈顿下界', '本策略/下界'];
  console.log(header.join('\t'));
  const stats = rows.map(([, list]) => phaseStats(list.map((r) => r.perFruit)));
  for (let p = 0; p < 4; p++) {
    console.log(
      [
        stats[0][p].name,
        stats[0][p].range,
        stats[0][p].avg.toFixed(1),
        stats[1][p].avg.toFixed(1),
        stats[2][p].avg.toFixed(1),
        stats[3][p].avg.toFixed(1),
        (stats[2][p].avg / stats[3][p].avg).toFixed(2) + '×'
      ].join('\t')
    );
  }

  const ok = results.strategy.every((r) => r.perFruit.length === FRUITS) && results.baseline.every((r) => r.perFruit.length === FRUITS);
  const faster = results.strategy.reduce((a, r) => a + r.steps, 0) < results.baseline.reduce((a, r) => a + r.steps, 0);
  console.log('');
  console.log(ok ? '✓ 所有方案均填满棋盘' : '✗ 存在未通关的局');
  console.log(faster ? '✓ 本策略总步数少于纯绕环基线' : '✗ 本策略没有优于基线');
  if (!ok || !faster) process.exit(1);
}

main();

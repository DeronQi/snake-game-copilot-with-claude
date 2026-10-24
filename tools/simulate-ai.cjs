#!/usr/bin/env node
/*
 * tools/simulate-ai.cjs —— AI 无头模拟
 *
 * 直接 require 浏览器里用的同一份 ai.js（规则 + AI），
 * 4 档难度 × 每档若干随机种子，断言每局都填满 400 格（吃到 397 个果实）。
 * 同时检查 AI 不变式（蛇身沿环有序）在每一步都成立。
 *
 * 用法：node tools/simulate-ai.cjs [每档种子数，默认且至少 5]
 */
'use strict';

const path = require('path');
const SnakeAI = require(path.join(__dirname, '..', 'ai.js'));

const SEEDS_PER_DIFFICULTY = Math.max(5, parseInt(process.argv[2], 10) || 5);
// 浏览器中 MAX 档的步频（与 game.js 中 AI_MAX_SPS 保持一致）
const AI_MAX_SPS = 1400;

function fmtMs(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

function runOne(difficulty, seed) {
  const game = SnakeAI.createGame({ rng: SnakeAI.mulberry32(seed) });
  const ai = SnakeAI.createAI(SnakeAI.COLS, SnakeAI.ROWS);
  if (!ai.isOrdered(game)) throw new Error('初始蛇身不满足 AI 不变式');
  let gameTimeMs = 0; // 按 ×1 速度换算的游戏内时长
  const t0 = process.hrtime.bigint();
  const limit = 400000;
  while (!game.over && game.steps < limit) {
    gameTimeMs += SnakeAI.intervalFor(difficulty, SnakeAI.levelForScore(game.score));
    const res = SnakeAI.step(game, ai.decide(game));
    if (res.died) break;
    if (!game.over && !ai.isOrdered(game)) throw new Error(`第 ${game.steps} 步不变式被破坏`);
  }
  const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    difficulty,
    seed,
    won: game.won,
    reason: game.deathReason,
    length: game.snake.length,
    score: game.score,
    steps: game.steps,
    cpuMs,
    gameTimeMs
  };
}

function main() {
  const cycle = SnakeAI.buildCycle(SnakeAI.COLS, SnakeAI.ROWS);
  if (!SnakeAI.verifyCycle(cycle, SnakeAI.COLS, SnakeAI.ROWS)) {
    console.error('✗ 哈密顿环校验失败');
    process.exit(1);
  }
  console.log(`✓ 哈密顿环校验通过（${SnakeAI.COLS}×${SnakeAI.ROWS}，${cycle.path.length} 格，首尾相邻闭合）`);
  console.log(`模拟：4 档难度 × ${SEEDS_PER_DIFFICULTY} 个随机种子\n`);
  console.log('难度     种子        结果   长度  得分    步数    CPU耗时  ×1游戏时长  MAX(浏览器)');
  console.log('-'.repeat(86));

  let failures = 0;
  const done = [];
  SnakeAI.DIFFICULTY_ORDER.forEach((diff, di) => {
    for (let i = 0; i < SEEDS_PER_DIFFICULTY; i++) {
      const seed = (0x5eed + di * 7919 + i * 104729) >>> 0;
      let r;
      try {
        r = runOne(diff, seed);
      } catch (err) {
        failures++;
        console.log(`${diff.padEnd(8)} ${String(seed).padEnd(10)}  ✗ 异常：${err.message}`);
        continue;
      }
      done.push(r);
      const ok = r.won && r.length === 400 && r.score === 397;
      if (!ok) failures++;
      console.log(
        `${diff.padEnd(8)} ${String(seed).padEnd(10)}  ${ok ? '✓通关' : '✗失败'}  ${String(r.length).padStart(4)}  ${String(r.score).padStart(4)}  ${String(r.steps).padStart(6)}  ${(r.cpuMs.toFixed(1) + 'ms').padStart(9)}  ${fmtMs(r.gameTimeMs).padStart(10)}  ${fmtMs((r.steps / AI_MAX_SPS) * 1000).padStart(10)}` +
          (ok ? '' : `  死因=${r.reason}`)
      );
    }
  });

  console.log('-'.repeat(86));
  if (done.length) {
    const steps = done.map((r) => r.steps);
    const avg = steps.reduce((a, b) => a + b, 0) / steps.length;
    const cpu = done.reduce((a, r) => a + r.cpuMs, 0);
    console.log(
      `共 ${done.length} 局：步数 平均 ${avg.toFixed(0)} / 最少 ${Math.min(...steps)} / 最多 ${Math.max(...steps)}；` +
        `CPU 总耗时 ${cpu.toFixed(0)}ms；MAX 档（${AI_MAX_SPS} 步/秒）预计浏览器内约 ${fmtMs((avg / AI_MAX_SPS) * 1000)} 通关`
    );
  }
  if (failures) {
    console.log(`\n✗ ${failures} 局失败`);
    process.exit(1);
  }
  console.log(`\n✓ 全部 ${done.length} 局填满 400 格（每局 397 个果实），0 失败`);
}

main();

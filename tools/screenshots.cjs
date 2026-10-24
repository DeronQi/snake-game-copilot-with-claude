#!/usr/bin/env node
/*
 * tools/screenshots.cjs —— 生成 README 用的截图（Playwright + Chromium）
 *
 * 输出到 docs/screenshots/：
 *   desktop-start.png   桌面开始界面
 *   desktop-ai.png      桌面 AI 演示中
 *   desktop-win.png     桌面 AI 通关面板
 *   desktop-over.png    桌面游戏结束面板
 *   phone-start.png     手机竖屏开始界面（屏幕方向键）
 *   phone-ai.png        手机竖屏 AI 演示中
 *   landscape-ai.png    手机横屏紧凑模式
 *
 * 用法：node tools/screenshots.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createStaticServer } = require('./serve.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

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

const state = (page, s, timeout) => page.waitForFunction((x) => document.body.dataset.state === x, s, { timeout });

async function setSpeed(page, label) {
  for (let i = 0; i < 5; i++) {
    if ((await page.textContent('#btnAISpeed')).trim() === label) return;
    await page.click('#btnAISpeed');
  }
}

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await createStaticServer({ root: ROOT, port: 0 });
  const browser = await chromium.launch();
  const saved = [];
  const shot = async (page, name) => {
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    saved.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  };

  try {
    // 桌面
    let ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    let page = await ctx.newPage();
    await page.goto(srv.url);
    await page.waitForTimeout(400);
    await shot(page, 'desktop-start.png');
    await page.click('#btnStartAI');
    await setSpeed(page, '×64');
    await page.waitForFunction(() => Number(document.getElementById('score').textContent) >= 150, null, { timeout: 60000 });
    await shot(page, 'desktop-ai.png');
    await setSpeed(page, 'MAX');
    await state(page, 'won', 90000);
    await page.waitForTimeout(600);
    await shot(page, 'desktop-win.png');
    await page.click('#btnWinRetry');
    await state(page, 'over', 15000); // 不操作，蛇直线撞墙
    await page.waitForTimeout(1200);
    await shot(page, 'desktop-over.png');
    await ctx.close();

    // 手机竖屏
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page = await ctx.newPage();
    await page.goto(srv.url);
    await page.waitForTimeout(400);
    await shot(page, 'phone-start.png');
    await page.tap('#btnStartAI');
    await setSpeed(page, '×64');
    await page.waitForFunction(() => Number(document.getElementById('score').textContent) >= 120, null, { timeout: 60000 });
    await shot(page, 'phone-ai.png');
    await ctx.close();

    // 手机横屏
    ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page = await ctx.newPage();
    await page.goto(srv.url);
    await page.tap('#btnStartAI');
    await setSpeed(page, '×64');
    await page.waitForFunction(() => Number(document.getElementById('score').textContent) >= 60, null, { timeout: 60000 });
    await shot(page, 'landscape-ai.png');
    await ctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  saved.forEach((s) => console.log('✓ ' + s));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

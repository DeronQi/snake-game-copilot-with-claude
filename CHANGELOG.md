# 更新日志

本项目的版本号与 `sw.js` 中的 `VERSION`、静态资源的 `?v=` 参数保持一致。

## [v1] - 2026-10-24

首个版本。

### 新增

- 20×20 贪吃蛇：计分、每 4 分升级（最高 10 级）、撞墙 / 咬到自己结束、填满 400 格通关。
- 四档难度（简单 / 普通 / 困难 / 疯狂），选择持久化。
- 最高分在刷新纪录的瞬间写入 `localStorage`。
- 键盘、鼠标拖动、触摸滑动、屏幕方向键四种操作；转向队列缓存 2 次转向；后台 / 失焦自动暂停。
- 保证通关的 AI 演示：哈密顿环 + 安全抄近路 + 门控；倍速 ×1 / ×4 / ×16 / ×64 / MAX（约 24 秒通关）。
- 响应式布局：棋盘始终正方形且完整可见；横屏紧凑模式；320px 适配；安全区适配；高 DPR 渲染。
- WebAudio 合成音效、手机震动、静音持久化；标签页标题实时同步；无障碍属性与 `prefers-reduced-motion`。
- PWA：manifest、Service Worker（网络优先 + 缓存兜底）、离线可用、发版后自动刷新一次。
- 验证脚本：`simulate-ai.cjs`、`analyze-ai.cjs`、`verify.cjs`、`verify-sw-update.cjs`；工具脚本：`make_icons.py`、`screenshots.cjs`、`serve.cjs`。
- 文档：README、`docs/AI.md`、`docs/TESTING.md`。

# Stage 6 Visual Redesign A — Deep Space Photography

## 方向

选择 A：深空摄影风。以近黑色深空、低对比蓝灰色银河尘埃、稀疏冷白星点为主；取消高饱和紫色雾团与三条发光带。整体应像安静的天文摄影，而不是科幻游戏 HUD。

## 本轮实际修改

- `src/web/client/scene.css`：将玻璃面板改为更克制的深色半透明层，减少渐变、圆角、边框高亮和投影。
- `src/web/client/scene-app.js`：替换节点与关系配色；背景改为低饱和尘埃云 + 920 个确定性星点；背景画布按尺寸缓存，避免相机旋转时反复重算星尘。
- 节点光晕缩小、降低不透明度；Episode 仅保留细轨道环；移除默认星芒；标签改为优先显示选中/搜索节点，并通过碰撞检测避免重叠。
- 自动旋转速度降至原来的约 1/10，默认画面更安静。
- `src/web/scene-page.ts`：更新主题色、标题与图例色值。
- `tests/scene-web.test.ts`：更新视觉契约断言。

## 不变的约束

- 数据仍来自同源只读 Scene / detail API。
- 不改数据库 migration、Experience/Episode/Memory/Pattern 数据语义或后端坐标。
- Scope 切换与隔离保持原状。
- 页面仍不发送 POST/PUT/DELETE；无执行 Skill 能力。
- 不引入 CDN、第三方运行时依赖或外部图片资源。

## 验收说明

此目录包含源码级改造。需在目标 Windows / DeepSeek Harness 环境执行 `npm run build`、测试与 `scripts/verify-stage6.mjs --port <当前端口>`，并在真实宿主页面复核色彩、密度与帧率。

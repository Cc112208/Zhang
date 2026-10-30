# Stage 6 · 深空星云视觉重构记录

> 历史记录：这是第一轮偏蓝紫星云的视觉版本。用户选择 A「深空摄影风」后，当前前端已由 `docs/STAGE6_VISUAL_REDESIGN_A.md` 的第二轮实现取代；后续以 A 版为准。

## 目标

将 3D Memory Sea 从偏调试工具式的暗色节点图，改为沉浸式深空星云：蓝紫星云、宏大空间纵深、发光星群、悬浮控制栏，以及仅在选中节点时展开的详情面板。

## 实际改动

- `src/web/client/scene.css`
  - 重做全屏深空配色、玻璃质感 HUD、顶部悬浮控制栏、底部统计胶囊、右侧详情面板与窄屏布局。
  - 增加详情面板入场动效、键盘焦点样式与 `prefers-reduced-motion` 支持。
  - 不引用外部字体、图片、CDN 或静态资源。
- `src/web/client/scene-app.js`
  - Canvas 背景改为多层蓝紫径向星云、低对比星云丝带、680 个确定性背景星点与暗角。
  - 加强 Experience / Episode / Memory / Pattern 的发光核心与类型区分；Episode 环仍反映真实 `experienceCount`，不是伪造关系。
  - 调整轨道相机默认构图，让真实节点在画面里更舒展；不改后端坐标、不重排 Scene。
  - 关系边可悬停，显示真实 `kind` 与 `reason`；节点选中后仍通过真实只读详情 API 下钻。
  - 增加详情关闭按钮、`/` 搜索快捷键、触屏指针事件与低动态偏好处理。
  - 当前 Scope 的 Memory 为 0 时显示解释性提示；不制造占位 Memory 节点。
- `src/web/scene-page.ts`
  - 更新自包含 HTML 结构、品牌标识、只读状态标识、详情面板头部和关系提示层。
- `src/index.ts`
  - Memory / Pattern 详情请求若携带 `?scope=`，会校验实体所属 Scope；跨 Scope 请求返回 404。未携带参数的既有调用保持兼容。
- `src/scope/path-normalizer.ts` 与 `tests/stage2.test.ts`
  - 让路径归一化按显式指定的平台选择 `win32` / `posix` 解析器，并修正 Windows 路径测试显式传入 `win32`，使跨平台回归在 Linux 和 Windows 上测试相同的规则。生产环境使用默认平台时行为不变。
- `tests/scene-web.test.ts`
  - 增加星云视觉、边理由提示、Memory=0 说明与详情关闭 UI 检查。
  - 增加 Memory / Pattern 详情跨 Scope 读取拒绝测试。

## 不变量

- 没有新增数据库 migration。
- Experience、Episode、Memory、Pattern 的存储语义与 Scene 坐标生成逻辑没有改变。
- 页面仍只请求同源 `/api/memory-sea/*` 接口，不发送 POST / PUT / DELETE。
- 没有引入 Three.js、WebGL 引擎、第三方运行时依赖或外部资源。
- Skill / 审核 / 执行能力不进入 Scene 页面。

## 验证记录

- TypeScript 类型检查：通过。
- `tests/scene-web.test.ts`：12 项通过。
- 完整测试套件：194 / 194 通过。
- `scripts/smoke.mjs`：`SMOKE OK`。
- `scripts/verify-stage6.mjs`：在临时本地测试 Harness 上通过；该次使用临时测试数据验证页面路由、Scene 结构、Scope 隔离、详情下钻与只读边界，不代表已在用户的 Windows DeepSeek Harness 上完成最终验收。
- 本次执行环境未能通过 `npm ci` 下载依赖（npm registry 网络请求超时），因此使用环境中的 TypeScript 编译器与现有 `@types/node` 完成类型检查、构建和测试；用户 Windows 环境仍应执行项目标准命令 `npm run build`。

## 用户侧验收

1. 在 Windows 项目目录执行 `npm run build`。
2. 完全退出并重新启动 DeepSeek Harness（避免旧插件实例继续响应旧页面）。
3. 打开 `/memory-sea/scene`；若宿主路由有冲突，可用 `/api/memory-sea/ui`。
4. 切换不同 Scope，确认节点数和内容随 Scope 改变；点击节点检查详情，悬停关系边检查 `reason`。
5. 确认默认 Scope 的 Memory 为 0 时只显示说明，不出现虚构的 Memory 节点。

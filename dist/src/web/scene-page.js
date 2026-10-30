/**
 * scene-page.ts —— 3D Memory Sea 页面（Stage 6）。
 *
 * 宿主只提供 `webServer.register({ kind, path, handler })`，没有静态目录托管，
 * 因此页面必须是**单个自包含 HTML**：CSS 与 JS 全部内联，无 CDN、无外部请求。
 *
 * CSS/JS 单独放在 `web/client/`（便于编辑与审阅），构建时由 copy-assets 同步到 dist，
 * 运行时按模块所在目录读取并内联。读不到就抛错（宿主会返回 500，而不是假装页面正常）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
let cachedCss = null;
let cachedJs = null;
function readAsset(name) {
    return readFileSync(join(here, 'client', name), 'utf8');
}
function assets() {
    if (cachedCss === null)
        cachedCss = readAsset('scene.css');
    if (cachedJs === null)
        cachedJs = readAsset('scene-app.js');
    return { css: cachedCss, js: cachedJs };
}
/** 生成整页 HTML。同一进程内 CSS/JS 只读一次（文件不会在运行中变化）。 */
export function renderScenePage() {
    const { css, js } = assets();
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#010309" />
<title>3D Memory Sea · Deep Space Atlas</title>
<style>
${css}
</style>
</head>
<body>
<canvas id="sea" aria-label="3D 记忆星海：拖动旋转，滚轮缩放，点击真实节点查看详情"></canvas>

<header class="hud" id="topbar" aria-label="星海控制栏">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-copy">
      <span class="brand-title">3D Memory Sea</span>
      <span class="brand-subtitle">EXPERIENCE · EPISODE · MEMORY</span>
    </span>
  </div>
  <span class="mode-switch" role="group" aria-label="视图模式">
    <button id="mode-global" type="button" class="mode-btn on" aria-pressed="true" title="把已知每个 Scope 的真实节点放到同一张星图里">全景</button>
    <button id="mode-scope" type="button" class="mode-btn" aria-pressed="false" title="只看一个 Scope 的数据">单 Scope</button>
  </span>
  <span class="brand-scope" title="当前 Scope"><b id="scope-current">-</b></span>
  <span class="group" id="scope-info" aria-live="polite"></span>
  <span class="settings-anchor">
    <button id="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel" title="显示/隐藏设置（Scope、搜索、类型过滤、视角）">
      <span class="gear" aria-hidden="true">⚙</span><span class="settings-label">设置</span>
    </button>
  </span>
</header>

<section class="hud" id="settings-panel" aria-label="星海设置" hidden>
  <div class="settings-row" id="scope-row">
    <label for="scope"><span>项目 / Scope</span><select id="scope" title="切换项目空间；不同 Scope 的数据严格隔离"></select></label>
  </div>
  <div class="settings-row" id="scope-filter-row" hidden>
    <span class="field-label">Scope 过滤（全景）</span>
    <div id="scope-filter" class="scope-filter" aria-label="选择全景里要显示的 Scope"></div>
    <p class="settings-hint">不勾选 = 显示全部；这里只过滤视图，不会合并或改写任何 Scope 的数据。</p>
  </div>
  <div class="settings-row">
    <label for="search"><span>搜索节点</span><input id="search" type="search" placeholder="搜索节点内容…" autocomplete="off" /></label>
  </div>
  <div class="settings-row type-filters" aria-label="节点类型过滤">
    <label class="toggle experience"><input id="filter-experience" type="checkbox" checked /><span>经历<b class="filter-count" id="count-experience">0</b></span></label>
    <label class="toggle episode"><input id="filter-episode" type="checkbox" checked /><span>连续经历<b class="filter-count" id="count-episode">0</b></span></label>
    <label class="toggle memory"><input id="filter-memory" type="checkbox" checked /><span>长期记忆<b class="filter-count" id="count-memory">0</b></span></label>
    <label class="toggle pattern"><input id="filter-pattern" type="checkbox" checked /><span>长期模式<b class="filter-count" id="count-pattern">0</b></span></label>
  </div>
  <div class="settings-row" id="db-row">
    <span class="field-label">数据位置</span>
    <p class="settings-hint" id="db-path">读取中…</p>
  </div>
  <div class="settings-row">
    <p class="settings-hint" id="hint-static">拖动旋转 · 滚轮缩放 · 单击节点看详情 · 双击节点聚焦 · 双击空白复位 · R 复位 · F 聚焦 · / 搜索 · Esc 关闭详情</p>
  </div>
  <div class="settings-row actions">
    <button id="reload" type="button" title="从真实 Scene API 重新读取">刷新数据</button>
    <button id="reset" type="button" title="复位到完整星海">复位视角</button>
    <button id="focus" type="button" title="把镜头拉到当前选中的节点（先点选节点）" disabled>聚焦选中</button>
  </div>
  <p class="settings-note">设置只影响本地视图（过滤/搜索/相机），不改变任何记忆数据。</p>
</section>

<div class="hud" id="stats" aria-label="当前 Scope 统计">
  <span><i class="dot" style="background:#b8cbe1;color:#b8cbe1"></i>经历<b id="stat-experiences">0</b></span>
  <span><i class="dot" style="background:#d9c39a;color:#d9c39a"></i>连续经历<b id="stat-episodes">0</b></span>
  <span><i class="dot" style="background:#a9cec6;color:#a9cec6"></i>长期记忆<b id="stat-memories">0</b></span>
  <span><i class="dot" style="background:#b9b6cb;color:#b9b6cb"></i>关系<b id="stat-relations">0</b></span>
  <span class="stat-separator" aria-hidden="true"></span>
  <span>节点<b id="stat-nodes">0</b></span>
  <span>边<b id="stat-edges">0</b></span>
  <span>Scope<b id="stat-scopes">0</b></span>
</div>

<div class="hud" id="statusbar" role="status" aria-live="polite"><span id="status">正在初始化星海…</span></div>
<div class="hud" id="scope-note" role="status" aria-live="polite"></div>
<div class="hud" id="hint">拖动旋转 · 滚轮缩放 · 单击节点看详情 · <b>双击节点聚焦</b> · 双击空白复位 · <kbd>R</kbd> 复位 · <kbd>F</kbd> 聚焦 · <kbd>/</kbd> 搜索 · <kbd>Esc</kbd> 关闭详情</div>
<div id="edge-tooltip" role="status" aria-live="polite"></div>

<aside class="hud" id="detail" aria-label="节点详情">
  <div class="detail-head">
    <div class="detail-kicker"><span class="detail-orb" aria-hidden="true"></span><span id="detail-type">节点详情</span></div>
    <button id="detail-close" type="button" aria-label="关闭详情" title="关闭详情">×</button>
  </div>
  <h2 id="detail-title"></h2>
  <div id="detail-meta"></div>
  <pre id="detail-body"></pre>
  <div id="detail-links"></div>
</aside>

<script>
${js}
</script>
</body>
</html>
`;
}

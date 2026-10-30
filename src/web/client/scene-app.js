/*
 * scene-app.js —— 3D Memory Sea 页面客户端（Stage 6）。
 *
 * 纯原生 JS + Canvas 2D 手写三维投影：不依赖任何 CDN、框架或 3D 引擎。
 * 数据全部来自同源只读接口 /api/memory-sea/*：
 *   /scopes                       已知 scope 列表
 *   /scene?scope=                 points + edges + stats（后端已给定稳定坐标）
 *   /experiences/:id              经历正文 + 所属 Episode
 *   /episodes/:id                 Episode + 成员经历 + 证据 Memory + 连续性
 *   /memories/:id                 长期记忆 + 证据
 *
 * 只读：本页面不会发送任何 POST/PUT/DELETE。
 */
(function () {
  'use strict'

  var API = '/api/memory-sea'
  // Deep Space Atlas palette: natural starlight, restrained warm episode markers, no neon bloom.
  var POINT_COLORS = {
    experience: { core: '#d6e4f7', glow: 'rgba(150,196,244,0.22)', rim: '#f4f9ff' },
    episode: { core: '#bfe6ff', glow: 'rgba(122,206,255,0.30)', rim: '#eefaff' },
    memory: { core: '#8ff2c4', glow: 'rgba(96,236,169,0.32)', rim: '#e2fff1' },
    pattern: { core: '#ffd08a', glow: 'rgba(255,182,84,0.30)', rim: '#fff2d8' },
  }
  // 全景叠加层的「亮芯」颜色：比基础边色更亮一档，保证在密集节点上仍然可见。
  var RELATION_CORE = {
    derived_from: 'rgba(150,214,255,0.95)',
    supports: 'rgba(126,236,180,0.95)',
    supported_by: 'rgba(126,236,180,0.9)',
    contradicted_by: 'rgba(255,140,126,0.95)',
    continues: 'rgba(255,206,138,0.95)',
    followup: 'rgba(255,206,138,0.9)',
    same_thread: 'rgba(190,190,238,0.85)',
    same_topic: 'rgba(168,196,232,0.8)',
  }

  function relationColor(kind) {
    return RELATION_CORE[kind] || 'rgba(200,210,230,0.85)'
  }

  var EDGE_STYLES = {
    contains: { color: 'rgba(168,196,232,0.26)', width: 0.7, dashed: false, label: '归属' },
    derived_from: { color: 'rgba(150,214,255,0.46)', width: 1, dashed: false, label: '提炼自' },
    supports: { color: 'rgba(126,236,180,0.42)', width: 1, dashed: false, label: '支持' },
    supported_by: { color: 'rgba(126,236,180,0.34)', width: 0.9, dashed: false, label: '被支持' },
    contradicted_by: { color: 'rgba(255,140,126,0.46)', width: 1, dashed: true, label: '被反驳' },
    continues: { color: 'rgba(255,206,138,0.44)', width: 1, dashed: true, label: '延续' },
    followup: { color: 'rgba(255,206,138,0.36)', width: 0.9, dashed: true, label: '后续' },
    same_thread: { color: 'rgba(190,190,238,0.32)', width: 0.9, dashed: true, label: '同一线索' },
    same_topic: { color: 'rgba(168,196,232,0.30)', width: 0.9, dashed: true, label: '同一话题' },
  }

  var state = {
    mode: 'global',
    scopeId: '',
    scopes: [],
    activeScopes: [],
    failures: [],
    scopeCenters: Object.create(null),
    scene: null,
    byId: Object.create(null),
    edgesByPoint: Object.create(null),
    points: [],
    filters: { experience: true, episode: true, memory: true, pattern: true },
    query: '',
    hoverId: null,
    hoverEdge: null,
    edgeHoverPos: null,
    selectedId: null,
    camera: { yaw: 0.6, pitch: -0.35, distance: 260, target: { x: 0, y: 0, z: 0 } },
    autoRotate: true,
    settingsOpen: false,
    dragVelocity: { yaw: 0, pitch: 0 },
    cameraGoal: null,
    lastInteractionAt: 0,
    projected: [],
    lodActive: false,
    backgroundCanvas: null,
    backgroundWidth: 0,
    backgroundHeight: 0,
    dirty: true,
    loading: false,
    detailSeq: 0,
    error: '',
  }

  var canvas = null
  var ctx = null
  var els = {}

  // ---------------------------------------------------------------- 工具函数

  function $(id) {
    return document.getElementById(id)
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '-'
    var d = new Date(ms)
    function p(n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function fmtNumber(n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '-'
    return Number(n.toFixed(digits === undefined ? 2 : digits)).toString()
  }

  // 旋转不受限：把任意角度折回 [-PI, PI]，让上下也能连续转满 360 度。
  var TAU = Math.PI * 2
  function wrapAngle(value) {
    var wrapped = (value + Math.PI) % TAU
    if (wrapped < 0) wrapped += TAU
    return wrapped - Math.PI
  }

  function truncate(text, max) {
    var s = String(text === undefined || text === null ? '' : text)
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }

  function shortId(id) {
    var s = String(id || '')
    return s.length <= 14 ? s : s.slice(0, 6) + '…' + s.slice(-6)
  }

  function typeLabel(type) {
    return { experience: '经历', episode: '连续经历', memory: '长期记忆', pattern: '长期模式' }[type] || String(type)
  }

  function edgeStyle(kind) {
    return EDGE_STYLES[kind] || { color: 'rgba(150,160,180,0.35)', width: 1, dashed: false, label: String(kind) }
  }

  // ---------------------------------------------------------------- HTTP

  function request(path) {
    return fetch(API + path, { headers: { accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || body.ok === false) {
          var message = (body && body.error) || ('HTTP ' + res.status)
          throw new Error(message)
        }
        return body
      })
    })
  }

  // Stage 7：全景模式一次读取所有 scope 的真实 Scene；单 scope 模式沿用 /scene。
  function scenePath() {
    if (state.mode === 'global') {
      var selected = state.activeScopes.length ? '?scopes=' + encodeURIComponent(state.activeScopes.join(',')) : ''
      return '/global-scene' + selected
    }
    return '/scene' + (state.scopeId ? '?scope=' + encodeURIComponent(state.scopeId) : '')
  }

  // ---------------------------------------------------------------- 加载

  // 只读展示数据库文件位置：让「记忆存在哪」在界面里可见（改路径见 README「自定义数据位置」）。
  function loadDatabasePath() {
    if (!els.dbPath) return Promise.resolve()
    return request('/status')
      .then(function (body) {
        var path = body && typeof body.databasePath === 'string' ? body.databasePath : ''
        els.dbPath.textContent = path || '未返回路径'
        els.dbPath.title = path
      })
      .catch(function () {
        els.dbPath.textContent = '读取失败（不影响浏览）'
      })
  }

  function loadScopes() {
    return request('/scopes').then(function (body) {
      var scopes = (body.scopes || []).slice()
      state.scopes = scopes
      var select = els.scope
      select.textContent = ''
      scopes.forEach(function (scope) {
        var option = el('option', null, scope.id + (scope.rootPath ? '  ·  ' + scope.rootPath : ''))
        option.value = scope.id
        select.appendChild(option)
      })
      var preferred = (body.defaultScope && body.defaultScope.id) || (scopes[0] && scopes[0].id) || ''
      if (!state.scopeId || !scopes.some(function (s) { return s.id === state.scopeId })) {
        state.scopeId = preferred
      }
      select.value = state.scopeId
      els.scopeInfo.textContent = scopes.length + ' 个 scope'
      renderScopeFilter()
    })
  }

  // 全景模式的 Scope 过滤：按真实 scope 列表渲染复选框；空集 = 显示全部。
  function renderScopeFilter() {
    if (!els.scopeFilter) return
    var host = els.scopeFilter
    host.textContent = ''
    var scopes = state.scopes || []
    if (!scopes.length) {
      host.appendChild(el('span', 'scope-empty', '没有可用的 Scope'))
      return
    }
    scopes.forEach(function (scope) {
      var label = el('label', 'scope-chip')
      var input = el('input')
      input.type = 'checkbox'
      input.value = scope.id
      input.checked = state.activeScopes.length === 0 || state.activeScopes.indexOf(scope.id) >= 0
      input.addEventListener('change', function () {
        var next = []
        scopes.forEach(function (item) {
          var box = host.querySelector('input[value="' + item.id.replace(/"/g, '\\"') + '"]')
          if (box && box.checked) next.push(item.id)
        })
        // 全选等价于「不过滤」，避免 URL 里塞满所有 scope
        state.activeScopes = next.length === scopes.length ? [] : next
        syncUrl()
        loadScene()
      })
      label.appendChild(input)
      label.appendChild(el('span', null, shortId(scope.id)))
      label.title = scope.id + (scope.rootPath ? '  ·  ' + scope.rootPath : '')
      host.appendChild(label)
    })
  }

  function loadScene() {
    state.loading = true
    setStatus('正在读取场景…')
    return request(scenePath())
      .then(function (body) {
        applyScene(body)
        state.error = ''
        var scopeText = state.mode === 'global'
          ? ((body.stats && body.stats.loadedScopes) || (body.scopes || []).length) + ' 个 Scope'
          : (state.scopeId || '1 个 Scope')
        var base = '已加载 ' + state.points.length + ' 个节点 / ' + ((body.edges || []).length) + ' 条边 · ' + scopeText
        var failed = (body.failures || []).length
        setStatus(failed ? base + ' · ' + failed + ' 个 Scope 读取失败（数据不完整）' : base, failed > 0)
        // 深链接：?select=<节点 id> 打开后直接选中该节点（可分享的证据链链接）。
        if (state.pendingSelect) {
          var target = state.pendingSelect
          state.pendingSelect = ''
          if (state.byId[target]) select(target)
        }
      })
      .catch(function (error) {
        state.error = String(error && error.message ? error.message : error)
        state.scene = null
        state.points = []
        state.byId = Object.create(null)
        state.edgesByPoint = Object.create(null)
        state.selectedId = null
        state.hoverId = null
        state.hoverEdge = null
        updateEdgeTooltip(null)
        renderDetail(null)
        updateStats()
        setStatus('加载失败：' + state.error, true)
        render()
      })
      .then(function () {
        state.loading = false
      })
  }

  function applyScene(body) {
    var points = (body.points || []).filter(function (point) {
      return point && typeof point.id === 'string' && POINT_COLORS[point.type]
    })
    var edges = (body.edges || []).filter(function (edge) {
      return edge && typeof edge.a === 'string' && typeof edge.b === 'string'
    })
    state.scene = body
    state.failures = body.failures || []
    state.points = points
    applyScopeLayout(points)
    state.byId = Object.create(null)
    state.edgesByPoint = Object.create(null)
    points.forEach(function (point) { state.byId[point.id] = point })
    edges.forEach(function (edge) {
      if (!state.byId[edge.a] || !state.byId[edge.b]) return
      ;(state.edgesByPoint[edge.a] || (state.edgesByPoint[edge.a] = [])).push(edge)
      ;(state.edgesByPoint[edge.b] || (state.edgesByPoint[edge.b] = [])).push(edge)
    })
    state.scene.edges = edges
    state.selectedId = null
    state.hoverId = null
    state.hoverEdge = null
    updateEdgeTooltip(null)
    fitCamera()
    renderScopeFilter()
    updateStats()
    renderDetail(null)
    render()
  }

  // 全景模式的空间分离：每个 scope 的坐标仍是它自己的真实布局，只是压缩后
  // 放到统一的球壳上，避免 11 个 scope 全叠在原点变成一个毛球。坐标只在视图层平移/缩放。
  function applyScopeLayout(points) {
    state.scopeCenters = Object.create(null)
    if (state.mode !== 'global') return
    var groups = Object.create(null)
    points.forEach(function (point) {
      if (!point.scopeId) return
      ;(groups[point.scopeId] || (groups[point.scopeId] = [])).push(point)
    })
    var ids = Object.keys(groups).sort(function (a, b) {
      return groups[b].length - groups[a].length || (a < b ? -1 : 1)
    })
    var count = ids.length
    if (count <= 1) return
    var total = points.length || 1
    // 每个 scope 先压缩到相近的体量，再放到一层薄球壳上：既分得清来源，又不会散成一堆孤岛。
    var target = 520
    var shell = Math.max(420, 160 + 15 * Math.sqrt(total))
    ids.forEach(function (scopeId, index) {
      var list = groups[scopeId]
      var cx = 0
      var cy = 0
      var cz = 0
      list.forEach(function (point) { cx += point.x; cy += point.y; cz += point.z })
      cx /= list.length || 1
      cy /= list.length || 1
      cz /= list.length || 1
      var span = 1
      list.forEach(function (point) {
        span = Math.max(span, Math.hypot(point.x - cx, point.y - cy, point.z - cz))
      })
      var scale = Math.max(0.14, Math.min(1, target / span))
      var y = 1 - ((index + 0.5) * 2) / count
      var ring = Math.sqrt(Math.max(0, 1 - y * y))
      var theta = index * 2.399963229728653
      var center = {
        x: Math.cos(theta) * ring * shell,
        y: y * shell * 0.72,
        z: Math.sin(theta) * ring * shell,
      }
      state.scopeCenters[scopeId] = center
      list.forEach(function (point) {
        point.x = center.x + (point.x - cx) * scale
        point.y = center.y + (point.y - cy) * scale
        point.z = center.z + (point.z - cz) * scale
      })
    })
  }

  function fitCamera() {
    if (state.points.length === 0) {
      state.camera = { yaw: 0.6, pitch: -0.35, distance: 260, target: { x: 0, y: 0, z: 0 } }
      return
    }
    var min = { x: Infinity, y: Infinity, z: Infinity }
    var max = { x: -Infinity, y: -Infinity, z: -Infinity }
    state.points.forEach(function (p) {
      min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x)
      min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y)
      min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z)
    })
    var center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
    // 全景模式下球壳中心是空的：把镜头目标放到节点最多的那个 scope 聚类上，
    // 这样滚轮放大时是朝着真实数据放大，而不是滚进一片空场。
    if (state.mode === 'global') {
      var counts = Object.create(null)
      state.points.forEach(function (p) {
        if (p.scopeId) counts[p.scopeId] = (counts[p.scopeId] || 0) + 1
      })
      var bestScope = ''
      var bestCount = 0
      Object.keys(counts).forEach(function (scopeId) {
        if (counts[scopeId] > bestCount) { bestCount = counts[scopeId]; bestScope = scopeId }
      })
      var bestCenter = bestScope ? state.scopeCenters[bestScope] : null
      if (bestCenter) center = { x: bestCenter.x, y: bestCenter.y, z: bestCenter.z }
    }
    // 相机按「最远的真实节点」取景：focal = min(w,h)*1.12，可见半高约 0.446*distance，
    // 所以要让半径 R 的内容正好铺满竖直方向，distance ≈ 2.3R。全景模式额外留一点边距。
    var maxRadius = 1
    state.points.forEach(function (p) {
      maxRadius = Math.max(maxRadius, Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z))
    })
    var factor = state.mode === 'global' ? 1.7 : 1.9
    state.camera.target = center
    state.camera.distance = Math.max(70, Math.min(20000, maxRadius * factor))
  }

  function updateStats() {
    var stats = (state.scene && state.scene.stats) || {}
    els.statExperiences.textContent = String(stats.experiences || 0)
    els.statEpisodes.textContent = String(stats.episodes || 0)
    els.statMemories.textContent = String(stats.memories || 0)
    var realEdges = (state.scene && state.scene.edges) || []
    var relationCount = realEdges.filter(function (edge) { return edge.kind !== 'contains' }).length
    els.statRelations.textContent = String(relationCount || stats.relations || 0)
    if (els.scopeNote) {
      var hasPoints = state.points.length > 0
      var hasMemory = Number(stats.memories || 0) > 0
      var lod = overviewLod()
      if (lod) {
        els.scopeNote.textContent = '缩略视图：当前只画 Episode / 长期记忆 / 模式（' + (stats.episodes || 0) + ' + ' + (stats.memories || 0) + ' + ' + (stats.patterns || 0) + ' 个节点），滚轮放大到近景会显示全部 ' + (stats.experiences || 0) + ' 条经历。节点与关系统计始终是真实总数。'
        els.scopeNote.classList.add('on')
      } else {
        els.scopeNote.textContent = hasPoints && !hasMemory
          ? (state.mode === 'global'
            ? '这些 Scope 里还没有长期记忆节点。星海展示的是真实 Experience 与 Episode；长期记忆需要多个 Episode 归纳后才会出现。'
            : '当前 Scope 尚无长期记忆节点。星海展示的是此项目真实的 Experience 与 Episode；可切换 Scope 查看已沉淀的长期知识。')
          : ''
        els.scopeNote.classList.toggle('on', hasPoints && !hasMemory)
      }
    }
    var counts = { experience: 0, episode: 0, memory: 0, pattern: 0 }
    state.points.forEach(function (point) {
      if (counts[point.type] !== undefined) counts[point.type] += 1
    })
    if (els.countExperience) els.countExperience.textContent = String(counts.experience)
    if (els.countEpisode) els.countEpisode.textContent = String(counts.episode)
    if (els.countMemory) els.countMemory.textContent = String(counts.memory)
    if (els.countPattern) els.countPattern.textContent = String(counts.pattern)
    els.statEdges.textContent = String(stats.edges || 0)
    if (els.statNodes) els.statNodes.textContent = String(state.points.length)
    if (els.statScopes) {
      var scopeCount = state.mode === 'global'
        ? (Number(stats.loadedScopes) || (state.scopes || []).length)
        : 1
      els.statScopes.textContent = String(scopeCount)
    }
    els.scopeCurrent.textContent = state.mode === 'global' ? '全景 · 全部 Scope' : (state.scopeId || '-')
    if (state.query.trim()) {
      els.scopeInfo.textContent = '匹配 ' + visiblePoints().length + ' / ' + state.points.length + ' 个节点'
    }
  }

  // ---------------------------------------------------------------- 渲染

  // 全景缩略层级：镜头很远时上千个 Experience 会挤成一团白点，关系线全被盖住。
  // 这一层只是「先看结构」：Experience 在放大后出现，节点/边数据始终是同一份真实数据，
  // 底部统计也一直显示真实总数（不会因为隐藏而不计数）。
  function overviewLod() {
    if (state.mode !== 'global') return false
    if (state.query.trim()) return false
    var showExperiences = state.filters.experience
    if (!showExperiences) return false
    return state.camera.distance > 1500
  }

  function visiblePoints() {
    var q = state.query.trim().toLowerCase()
    var lod = overviewLod()
    return state.points.filter(function (p) {
      if (!state.filters[p.type]) return false
      if (lod && p.type === 'experience') return false
      // 全景模式：按选中的 Scope 过滤（空集 = 全部）；单 scope 模式本来就只有一组。
      if (state.mode === 'global' && state.activeScopes.length && state.activeScopes.indexOf(p.scopeId) < 0) return false
      if (!q) return true
      var hay = (p.label || '') + ' ' + (p.summary || '') + ' ' + (p.kind || '') + ' ' + (p.sourceType || '')
      return hay.toLowerCase().indexOf(q) >= 0
    })
  }

  function rotatePoint(point, cam) {
    var x = point.x - cam.target.x
    var y = point.y - cam.target.y
    var z = point.z - cam.target.z
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw)
    var x1 = x * cy + z * sy
    var z1 = -x * sy + z * cy
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
    var y2 = y * cp - z1 * sp
    var z2 = y * sp + z1 * cp
    return { x: x1, y: y2, z: z2 }
  }

  function project(point, cam, w, h) {
    var r = rotatePoint(point, cam)
    var depth = cam.distance - r.z
    if (depth <= 1) return null
    var focal = Math.min(w, h) * 1.12
    var scale = focal / depth
    return {
      x: w / 2 + r.x * scale,
      y: h / 2 + r.y * scale,
      scale: scale,
      depth: depth,
    }
  }

  function render() {
    if (!ctx) return
    var dpr = window.devicePixelRatio || 1
    var w = canvas.clientWidth
    var h = canvas.clientHeight
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    drawBackground(w, h)

    var cam = state.camera
    var list = visiblePoints()
    // 缩略层级会随缩放切换：只在真正切换时刷新一次面板文案，避免每帧改 DOM。
    var lodNow = overviewLod()
    if (lodNow !== state.lodActive) {
      state.lodActive = lodNow
      updateStats()
    }
    var positions = Object.create(null)
    state.projected = []

    for (var i = 0; i < list.length; i += 1) {
      var point = list[i]
      var pos = project(point, cam, w, h)
      if (!pos) continue
      positions[point.id] = pos
      state.projected.push({ point: point, pos: pos })
    }
    state.positions = positions

    // 边：只画两端都可见的。先画 contains（作为背景归属），再画语义/证据关系。
    var edges = (state.scene && state.scene.edges) || []
    var highlightId = state.selectedId || state.hoverId
    function drawEdges(predicate, alphaFactor) {
      for (var e = 0; e < edges.length; e += 1) {
        var edge = edges[e]
        if (!predicate(edge)) continue
        var a = positions[edge.a]
        var b = positions[edge.b]
        if (!a || !b) continue
        var style = edgeStyle(edge.kind)
        var edgeHovered = state.hoverEdge === edge
        var active = edgeHovered || (highlightId && (edge.a === highlightId || edge.b === highlightId))
        if (active) {
          ctx.save()
          ctx.beginPath()
          ctx.strokeStyle = style.color
          ctx.globalAlpha = edgeHovered ? 0.16 : 0.08
          ctx.lineWidth = Math.max(2.5, style.width * 2.8)
          ctx.shadowColor = style.color
          ctx.shadowBlur = 4
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.restore()
        }
        ctx.beginPath()
        ctx.strokeStyle = edgeHovered ? '#dce7ff' : style.color
        ctx.globalAlpha = (edgeHovered ? 0.92 : active ? 0.76 : 0.54) * alphaFactor
        ctx.lineWidth = style.width * (edgeHovered ? 1.8 : active ? 1.35 : 1)
        if (style.dashed) ctx.setLineDash([4, 5]); else ctx.setLineDash([])
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      ctx.setLineDash([])
    }
    // contains 是「经历归属」的背景骨架；语义/证据关系才是要看的关系，所以画得更清楚。
    // contains 的浓淡跟着镜头走：全景缩得很远时只是淡背景，放大后要能看清归属线。
    var nearness = Math.max(0, Math.min(1, (1305 - state.camera.distance) / 1130))
    var containsAlpha = state.mode === 'global' ? 0.20 + nearness * 0.62 : 0.72
    drawEdges(function (edge) { return edge.kind === 'contains' }, containsAlpha)
    drawEdges(function (edge) { return edge.kind !== 'contains' }, state.mode === 'global' ? 1.25 : 1)

    // 节点之后：语义/证据关系再叠两层加法光（先柔光、后亮芯）。数据仍是同一批真实边，
    // 只是保证密集的小节点不会把关系网络完全盖住；选中/悬停时依旧更亮。
    if (state.mode === 'global') {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (var pass = 0; pass < 2; pass += 1) {
        var soft = pass === 0
        var lod = overviewLod()
        ctx.globalAlpha = soft ? (lod ? 0.42 : 0.30) : (lod ? 0.95 : 0.72)
        ctx.lineWidth = soft ? (lod ? 4.4 : 3.2) : (lod ? 2.0 : 1.35)
        ctx.shadowBlur = soft ? 7 : 0
        for (var re = 0; re < edges.length; re += 1) {
          var relation = edges[re]
          if (relation.kind === 'contains') continue
          var ra = positions[relation.a]
          var rb = positions[relation.b]
          if (!ra || !rb) continue
          var relStyle = edgeStyle(relation.kind)
          ctx.strokeStyle = soft ? relStyle.color : relationColor(relation.kind)
          ctx.shadowColor = relStyle.color
          ctx.beginPath()
          ctx.moveTo(ra.x, ra.y)
          ctx.lineTo(rb.x, rb.y)
          ctx.stroke()
        }
      }
      ctx.restore()
    }

    // 节点：按深度从远到近绘制（远端先画，近端覆盖）。
    state.projected.sort(function (a, b) { return b.pos.depth - a.pos.depth })
    for (var j = 0; j < state.projected.length; j += 1) {
      var item = state.projected[j]
      drawPoint(item.point, item.pos)
    }

    // 标签遵循星图阅读方式：默认少量关键节点可读，密集区域不互相压字；
    // 选中/搜索命中永远优先。标签只是 UI，不改变节点或关系数据。
    ctx.font = '10.5px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    var searching = state.query.trim().length > 0
    var highlightId0 = highlightId
    var labelCandidates = state.projected.filter(function (entry) {
      var p = entry.point
      if (p.id === highlightId0 || searching) return true
      if (p.type !== 'experience') return true
      var size = typeof p.size === 'number' ? p.size : 1
      return size >= 1.55 && entry.pos.scale >= 0.75
    })
    labelCandidates.sort(function (a, b) {
      function priority(entry) {
        if (entry.point.id === highlightId0) return 0
        if (searching) return 1
        if (entry.point.type === 'episode') return 2
        if (entry.point.type === 'memory') return 3
        if (entry.point.type === 'pattern') return 4
        return 5
      }
      var pa = priority(a)
      var pb = priority(b)
      if (pa !== pb) return pa - pb
      var sa = typeof a.point.size === 'number' ? a.point.size : 0
      var sb = typeof b.point.size === 'number' ? b.point.size : 0
      return sb - sa || a.pos.depth - b.pos.depth
    })
    if (labelCandidates.length > 120) labelCandidates = labelCandidates.slice(0, 120)
    var labelBoxes = []
    for (var k = 0; k < labelCandidates.length; k += 1) {
      var entry = labelCandidates[k]
      var p = entry.point
      var focused = p.id === highlightId
      var label = truncate(p.label || p.id, p.type === 'episode' ? 24 : 18)
      var x = entry.pos.x
      var y = entry.pos.y + pointRadius(p, entry.pos) + 5
      var width = ctx.measureText(label).width + 10
      var box = { left: x - width / 2, right: x + width / 2, top: y - 2, bottom: y + 14 }
      var collides = labelBoxes.some(function (other) {
        return !(box.right < other.left - 7 || box.left > other.right + 7 || box.bottom < other.top - 4 || box.top > other.bottom + 4)
      })
      if (collides && !focused) continue
      labelBoxes.push(box)
      ctx.lineWidth = 2.6
      ctx.strokeStyle = 'rgba(2,4,9,0.86)'
      ctx.strokeText(label, x, y)
      ctx.fillStyle = focused ? 'rgba(248,252,255,0.98)' : 'rgba(206,220,240,0.66)'
      ctx.fillText(label, x, y)
    }

    // 全景模式：在聚类中心标注 scope 名，让人一眼看出这片星云来自哪个项目（纯视图标注）。
    if (state.mode === 'global') {
      ctx.save()
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      Object.keys(state.scopeCenters).forEach(function (scopeId) {
        var pos = project(state.scopeCenters[scopeId], cam, w, h)
        if (!pos) return
        ctx.fillStyle = 'rgba(150,182,222,0.42)'
        ctx.fillText(shortId(scopeId), pos.x, pos.y)
      })
      ctx.restore()
    }

    // 轻量泛光：把已画好的画面自身模糊后叠加回画面，让亮节点像真实光源一样扩散。
    // 纯表现层后处理，不改变任何节点/边的数据或位置。
    if (typeof ctx.filter === 'string' && state.mode !== 'global') {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.26
      ctx.filter = 'blur(6px)'
      ctx.drawImage(canvas, 0, 0, w, h)
      ctx.restore()
      ctx.filter = 'none'
    }

    if (state.points.length === 0) {
      drawEmpty(w, h, state.error ? '加载失败：' + state.error : '该 scope 暂无经历节点')
    } else if (list.length === 0) {
      drawEmpty(w, h, '当前过滤/搜索没有匹配的节点')
    }
    if (state.error && state.points.length > 0) {
      ctx.fillStyle = 'rgba(255,138,138,0.9)'
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText('加载失败：' + state.error, 16, 16)
    }
    state.dirty = false
  }

  function drawBackground(w, h) {
    // 背景是静态星野：缓存到独立 Canvas，轨道相机旋转时只做 drawImage，
    // 避免每帧重算星尘/径向渐变，也让视觉更像安静的深空摄影而不是游戏背景。
    var bw = Math.max(1, Math.ceil(w))
    var bh = Math.max(1, Math.ceil(h))
    if (!state.backgroundCanvas || state.backgroundWidth !== bw || state.backgroundHeight !== bh) {
      state.backgroundCanvas = document.createElement('canvas')
      state.backgroundCanvas.width = bw
      state.backgroundCanvas.height = bh
      state.backgroundWidth = bw
      state.backgroundHeight = bh
      var screenContext = ctx
      ctx = state.backgroundCanvas.getContext('2d')
      paintBackground(w, h)
      ctx = screenContext
    }
    ctx.drawImage(state.backgroundCanvas, 0, 0, w, h)
  }

  function paintBackground(w, h) {
    var gradient = ctx.createLinearGradient(0, 0, w * 0.18, h)
    gradient.addColorStop(0, '#000206')
    gradient.addColorStop(0.42, '#020610')
    gradient.addColorStop(0.72, '#010409')
    gradient.addColorStop(1, '#000206')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)

    // 中心一团很淡的冷色星云，让整个星图有"悬浮在深空里"的体积感。
    var core = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.62)
    core.addColorStop(0, 'rgba(48,96,158,0.16)')
    core.addColorStop(0.36, 'rgba(30,62,110,0.09)')
    core.addColorStop(0.72, 'rgba(16,34,64,0.04)')
    core.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = core
    ctx.fillRect(0, 0, w, h)

    // 极淡的银河尘埃带：宽阔、柔和、不画成一条发光丝带。
    // 这些背景云层只负责氛围，与 Scene API 中的真实关系边严格分开。
    var clouds = [
      { x: 0.46, y: 0.54, rx: 0.72, ry: 0.31, rot: -0.27, core: 'rgba(44,74,116,0.10)', mid: 'rgba(24,44,76,0.05)' },
      { x: 0.76, y: 0.27, rx: 0.39, ry: 0.43, rot: 0.44, core: 'rgba(34,58,94,0.07)', mid: 'rgba(22,36,62,0.035)' },
      { x: 0.18, y: 0.72, rx: 0.39, ry: 0.27, rot: -0.19, core: 'rgba(28,58,92,0.06)', mid: 'rgba(20,36,62,0.03)' },
      { x: 0.56, y: 0.12, rx: 0.34, ry: 0.23, rot: 0.16, core: 'rgba(52,64,92,0.04)', mid: 'rgba(28,36,56,0.02)' },
    ]
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    for (var n = 0; n < clouds.length; n += 1) {
      var cloud = clouds[n]
      ctx.save()
      ctx.translate(cloud.x * w, cloud.y * h)
      ctx.rotate(cloud.rot)
      ctx.scale(cloud.rx * w, cloud.ry * h)
      var fog = ctx.createRadialGradient(0, 0, 0.01, 0, 0, 1)
      fog.addColorStop(0, cloud.core)
      fog.addColorStop(0.34, cloud.mid)
      fog.addColorStop(0.68, 'rgba(16,27,45,0.025)')
      fog.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = fog
      ctx.fillRect(-1, -1, 2, 2)
      ctx.restore()
    }
    ctx.restore()

    // 确定性星场：大部分星点集中在倾斜的银河平面，其余散落于深空。
    // 亮星数量刻意稀少，避免十字星芒和高饱和霓虹抢过真实记忆节点。
    if (!state.backgroundStars) {
      var stars = []
      var seed = 713
      function rand() {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      var starColors = ['#d9e4f1', '#c2d5eb', '#a9bfdc', '#e4e1d9', '#b8c8dc']
      for (var i = 0; i < 920; i += 1) {
        var inPlane = rand() < 0.64
        var x = rand()
        var noise = rand() + rand() + rand() - 1.5
        var y = inPlane ? 0.68 - x * 0.37 + noise * 0.17 : rand()
        y = Math.max(0.015, Math.min(0.985, y))
        var layer = i < 650 ? 0 : i < 850 ? 1 : 2
        stars.push({
          x: x,
          y: y,
          r: layer === 0 ? 0.22 + rand() * 0.42 : layer === 1 ? 0.35 + rand() * 0.58 : 0.58 + rand() * 0.82,
          a: layer === 0 ? 0.045 + rand() * 0.10 : layer === 1 ? 0.07 + rand() * 0.15 : 0.12 + rand() * 0.20,
          color: starColors[Math.floor(rand() * starColors.length)],
        })
      }
      state.backgroundStars = stars
    }
    for (var d = 0; d < state.backgroundStars.length; d += 1) {
      var star = state.backgroundStars[d]
      ctx.globalAlpha = star.a
      ctx.fillStyle = star.color
      ctx.beginPath()
      ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // 轻微暗角保留深空黑位，中心并不额外打紫光。
    var vignette = ctx.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.16, w * 0.5, h * 0.48, Math.max(w, h) * 0.8)
    vignette.addColorStop(0, 'rgba(0,2,6,0)')
    vignette.addColorStop(0.58, 'rgba(0,2,6,0.08)')
    vignette.addColorStop(1, 'rgba(0,1,4,0.66)')
    ctx.fillStyle = vignette
    ctx.fillRect(0, 0, w, h)
  }

  function pointRadius(point, pos) {
    var base = point.type === 'memory' ? 4.8 : point.type === 'episode' ? 3.3 : point.type === 'pattern' ? 4.0 : 1.15
    // 缩略层级里只剩语义节点，稍微放大一点，让「结构图」本身可读。
    if (state.mode === 'global' && overviewLod() && point.type !== 'experience') base *= 1.7
    var size = typeof point.size === 'number' && isFinite(point.size) ? point.size : 1
    var globalScale = state.mode === 'global' ? 0.62 : 1
    var radius = base * globalScale * Math.min(2.6, Math.max(0.62, size / 2.1)) * Math.min(3.2, Math.max(0.42, pos.scale * 2.0))
    var minRadius = point.type === 'experience' ? (state.mode === 'global' ? 0.7 : 0.95) : (state.mode === 'global' ? 1.5 : 2.0)
    return Math.max(minRadius, Math.min(point.type === 'memory' ? 19 : 13, radius))
  }

  function drawPoint(point, pos) {
    var color = POINT_COLORS[point.type] || POINT_COLORS.experience
    var radius = pointRadius(point, pos)
    var activation = typeof point.activation === 'number' && isFinite(point.activation) ? point.activation : 0.6
    var importance = typeof point.importance === 'number' && isFinite(point.importance) ? point.importance : 0.5
    var focused = state.selectedId === point.id
    var hovered = state.hoverId === point.id
    var bright = focused || hovered

    // 节点保留自然星体的微弱散射光；普通 Experience 不做大范围发光。
    var glowFactor = state.mode === 'global' ? 0.42 : 1
    var glowRadius = radius * (point.type === 'experience' ? 2.0 : point.type === 'episode' ? 2.4 : 2.5) * glowFactor
    var glow = ctx.createRadialGradient(pos.x, pos.y, Math.max(0.1, radius * 0.06), pos.x, pos.y, glowRadius)
    glow.addColorStop(0, color.glow)
    glow.addColorStop(0.28, color.glow)
    glow.addColorStop(0.62, color.glow.replace(/[\d.]+\)$/, '0.10)'))
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    var glowAlpha = state.mode === 'global' ? 0.13 : 1
    ctx.globalAlpha = (0.30 + activation * 0.24) * glowAlpha * (bright ? 1.45 : 1)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    if (point.type === 'episode') {
      // Episode 以一圈细轨道表示连续经历，不使用粗重双环。
      var ratio = Math.min(1, Math.max(0, (point.experienceCount || 0) / 60))
      ctx.save()
      ctx.strokeStyle = 'rgba(217,195,154,' + (0.46 + ratio * 0.20) + ')'
      ctx.lineWidth = 0.65 + ratio * 0.55
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius + 2.3 + ratio * 1.2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    } else if (point.type === 'memory') {
      ctx.save()
      ctx.strokeStyle = 'rgba(169,206,198,0.42)'
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius + 3.2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    } else if (point.type === 'pattern') {
      ctx.save()
      ctx.translate(pos.x, pos.y)
      ctx.rotate(Math.PI / 4)
      ctx.strokeStyle = 'rgba(185,182,203,0.48)'
      ctx.lineWidth = 0.8
      ctx.strokeRect(-radius - 2.4, -radius - 2.4, (radius + 2.4) * 2, (radius + 2.4) * 2)
      ctx.restore()
    }

    var core = ctx.createRadialGradient(pos.x - radius * 0.27, pos.y - radius * 0.31, Math.max(0.1, radius * 0.04), pos.x, pos.y, radius * 1.08)
    core.addColorStop(0, color.rim)
    core.addColorStop(0.45, color.core)
    core.addColorStop(1, color.core)
    ctx.beginPath()
    ctx.fillStyle = core
    ctx.globalAlpha = 0.9 + Math.min(0.1, activation * 0.1)
    ctx.arc(pos.x, pos.y, radius * (bright ? 1.08 : 1), 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1

    // 只在交互时加细描边；默认节点不出现星芒或十字高光。
    if (bright || importance >= 0.94) {
      ctx.save()
      ctx.strokeStyle = bright ? 'rgba(235,242,250,0.9)' : 'rgba(218,228,240,0.34)'
      ctx.lineWidth = bright ? 1.2 : 0.6
      ctx.shadowColor = color.core
      ctx.shadowBlur = bright ? 4 : 0
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius + (focused ? 4.2 : hovered ? 3.2 : 1.8), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  function drawEmpty(w, h, text) {
    ctx.fillStyle = 'rgba(214,224,244,0.66)'
    ctx.font = '14px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, h / 2)
  }

  // ---------------------------------------------------------------- 拾取与交互

  function pick(mx, my) {
    var best = null
    var bestDistance = Infinity
    for (var i = 0; i < state.projected.length; i += 1) {
      var entry = state.projected[i]
      var radius = pointRadius(entry.point, entry.pos) + 7
      var distance = Math.hypot(entry.pos.x - mx, entry.pos.y - my)
      if (distance <= radius && distance < bestDistance) {
        best = entry.point
        bestDistance = distance
      }
    }
    return best
  }

  function pickEdge(mx, my) {
    if (!state.scene || !state.scene.edges || !state.positions) return null
    var best = null
    var bestDistance = 5.5
    var edges = state.scene.edges
    for (var i = 0; i < edges.length; i += 1) {
      var edge = edges[i]
      var a = state.positions[edge.a]
      var b = state.positions[edge.b]
      if (!a || !b) continue
      var dx = b.x - a.x
      var dy = b.y - a.y
      var lengthSq = dx * dx + dy * dy
      if (lengthSq <= 0.001) continue
      var t = Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / lengthSq))
      var px = a.x + t * dx
      var py = a.y + t * dy
      var distance = Math.hypot(mx - px, my - py)
      if (distance < bestDistance) {
        bestDistance = distance
        best = edge
      }
    }
    return best
  }

  function updateEdgeTooltip(edge, mx, my) {
    if (!els.edgeTooltip) return
    if (!edge) {
      els.edgeTooltip.classList.remove('on')
      els.edgeTooltip.textContent = ''
      return
    }
    els.edgeTooltip.textContent = ''
    var style = edgeStyle(edge.kind)
    els.edgeTooltip.appendChild(el('strong', null, style.label + ' · ' + edge.kind))
    els.edgeTooltip.appendChild(el('span', null, String(edge.reason || '该关系暂无说明')))
    els.edgeTooltip.style.left = Math.max(10, Math.min(window.innerWidth - 350, mx + 18)) + 'px'
    els.edgeTooltip.style.top = Math.max(84, Math.min(window.innerHeight - 90, my + 18)) + 'px'
    els.edgeTooltip.classList.add('on')
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return
    state.dragVelocity = { yaw: 0, pitch: 0 }
    state.cameraGoal = null
    state.lastInteractionAt = performance.now()
    state.dragging = { x: event.clientX, y: event.clientY, yaw: state.camera.yaw, pitch: state.camera.pitch, moved: 0, lastX: event.clientX, lastY: event.clientY }
  }

  function handlePointerMove(event) {
    if (!state.dragging && event.target !== canvas) {
      if (state.hoverId || state.hoverEdge) {
        state.hoverId = null
        state.hoverEdge = null
        updateEdgeTooltip(null)
        render()
      }
      return
    }
    var rect = canvas.getBoundingClientRect()
    var mx = event.clientX - rect.left
    var my = event.clientY - rect.top
    if (state.dragging) {
      var dx = event.clientX - state.dragging.x
      var dy = event.clientY - state.dragging.y
      var stepX = event.clientX - state.dragging.lastX
      var stepY = event.clientY - state.dragging.lastY
      state.dragging.lastX = event.clientX
      state.dragging.lastY = event.clientY
      state.dragging.moved = Math.max(state.dragging.moved, Math.abs(dx) + Math.abs(dy))
      state.camera.yaw = state.dragging.yaw + dx * 0.0075
      // 纵向也允许转满 360 度（wrap 而不是夹在 ±1.35）
      state.camera.pitch = wrapAngle(state.dragging.pitch + dy * 0.0075)
      // 记录甩动速度，松手后按惯性继续转一小段
      state.dragVelocity.yaw = state.dragVelocity.yaw * 0.55 + stepX * 0.0075 * 0.45
      state.dragVelocity.pitch = state.dragVelocity.pitch * 0.55 + stepY * 0.0075 * 0.45
      state.autoRotate = false
      state.lastInteractionAt = performance.now()
      render()
      return
    }
    var hovered = pick(mx, my)
    var nextId = hovered ? hovered.id : null
    var nextEdge = hovered ? null : pickEdge(mx, my)
    if (nextId !== state.hoverId || nextEdge !== state.hoverEdge) {
      state.hoverId = nextId
      state.hoverEdge = nextEdge
      canvas.style.cursor = hovered || nextEdge ? 'pointer' : 'grab'
      if (nextEdge) updateEdgeTooltip(nextEdge, event.clientX, event.clientY)
      else updateEdgeTooltip(null)
      render()
    }
  }

  function handlePointerUp(event) {
    if (!state.dragging) return
    var moved = state.dragging.moved
    state.dragging = null
    state.lastInteractionAt = performance.now()
    if (moved > 4) return
    var rect = canvas.getBoundingClientRect()
    var hit = pick(event.clientX - rect.left, event.clientY - rect.top)
    updateEdgeTooltip(null)
    state.hoverEdge = null
    select(hit ? hit.id : null)
  }

  function handleWheel(event) {
    event.preventDefault()
    var factor = Math.exp(event.deltaY * 0.0012)
    state.camera.distance = Math.max(30, Math.min(4000, state.camera.distance * factor))
    state.dragVelocity = { yaw: 0, pitch: 0 }
    state.lastInteractionAt = performance.now()
    render()
  }

  // 深链接：把「当前 scope + 选中节点 + 搜索词」写回地址栏，方便分享与刷新后回到同一视图。
  function syncUrl() {
    try {
      if (!window.history || typeof window.history.replaceState !== 'function') return
      var params = new URLSearchParams(window.location.search)
      if (state.mode === 'global') params.set('mode', 'global')
      else params.set('mode', 'scope')
      if (state.mode === 'global' && state.activeScopes.length) params.set('scopes', state.activeScopes.join(','))
      else params.delete('scopes')
      if (state.scopeId) params.set('scope', state.scopeId)
      else params.delete('scope')
      if (state.selectedId) params.set('select', state.selectedId)
      else params.delete('select')
      if (state.query) params.set('q', state.query)
      else params.delete('q')
      window.history.replaceState(null, '', window.location.pathname + '?' + params.toString())
    } catch (error) {
      /* 深链接只是增强，失败不影响交互 */
    }
  }

  // 详情面板里给的是原始 id（ep_/xp_/mem_/pat_）；全景模式下要映射回带 scope 的全局 id。
  function resolveRef(id) {
    if (!id) return null
    if (state.byId[id]) return id
    var owner = state.selectedId ? state.byId[state.selectedId] : null
    if (owner && owner.scopeId) {
      var scoped = owner.scopeId + '::' + id
      if (state.byId[scoped]) return scoped
    }
    var keys = Object.keys(state.byId)
    var suffix = '::' + id
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i].length > suffix.length && keys[i].slice(-suffix.length) === suffix) return keys[i]
    }
    return null
  }

  function select(id) {
    id = resolveRef(id)
    state.selectedId = id
    if (els.focus) els.focus.disabled = !id
    syncUrl()
    if (id) {
      state.autoRotate = false
      renderDetailLoading(id)
      var seq = ++state.detailSeq
      loadDetail(id, seq)
    } else {
      renderDetail(null)
    }
    render()
  }

  // 把镜头平滑推到选中节点：只改相机（目标点 + 距离），不动任何数据。
  function focusSelected() {
    var point = state.selectedId ? state.byId[state.selectedId] : null
    if (!point) {
      flashStatus('先在星海里点选一个节点，再点「聚焦选中」')
      return
    }
    var distance = Math.max(40, Math.min(state.camera.distance * 0.6, 160))
    state.cameraGoal = {
      fromTarget: { x: state.camera.target.x, y: state.camera.target.y, z: state.camera.target.z },
      fromDistance: state.camera.distance,
      target: { x: point.x, y: point.y, z: point.z },
      distance: distance,
      startedAt: performance.now(),
      duration: 520,
    }
    state.autoRotate = false
    state.lastInteractionAt = performance.now()
    flashStatus('已聚焦：' + truncate(point.label || point.id, 32))
    render()
  }

  // 底部状态条临时提示，2.4 秒后恢复原状态文案
  var flashTimer = null
  function flashStatus(message) {
    if (!els.status) return
    var previous = els.status.textContent
    setStatus(message)
    if (flashTimer) window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(function () {
      flashTimer = null
      setStatus(previous)
    }, 2400)
  }

  function resetView() {
    fitCamera()
    state.autoRotate = true
    render()
  }

  // ---------------------------------------------------------------- 详情面板

  function renderDetailLoading(id) {
    var point = state.byId[id]
    if (!point) return
    els.detailTitle.textContent = truncate(point.label || point.id, 80)
    if (els.detailType) els.detailType.textContent = typeLabel(point.type)
    els.detailMeta.textContent = '正在读取详情…'
    els.detailBody.textContent = ''
    els.detailLinks.textContent = ''
    els.detail.classList.add('on')
  }

  function loadDetail(id, seq) {
    var point = state.byId[id]
    if (!point) return
    // 全景模式的节点 id 带 scope 命名空间，详情接口要的是原始 id + 所属 scope。
    var targetId = point.originalId || id
    var scopeId = point.scopeId || state.scopeId
    var suffix = scopeId ? '?scope=' + encodeURIComponent(scopeId) : ''
    var path = null
    if (point.type === 'experience') path = '/experiences/' + encodeURIComponent(targetId) + suffix
    else if (point.type === 'episode') path = '/episodes/' + encodeURIComponent(targetId) + suffix
    else if (point.type === 'memory') path = '/memories/' + encodeURIComponent(targetId) + suffix
    else if (point.type === 'pattern') path = '/patterns/' + encodeURIComponent(targetId) + suffix
    if (!path) return
    request(path)
      .then(function (body) {
        if (seq !== state.detailSeq) return
        renderDetail(point, body)
      })
      .catch(function (error) {
        if (seq !== state.detailSeq) return
        els.detailMeta.textContent = '详情读取失败：' + (error && error.message ? error.message : error)
      })
  }

  function metaRow(label, value) {
    var row = el('div', 'row')
    row.appendChild(el('span', 'k', label))
    row.appendChild(el('span', 'v', value === undefined || value === null || value === '' ? '-' : String(value)))
    return row
  }

  function renderDetail(point, body) {
    els.detailLinks.textContent = ''
    if (!point) {
      els.detail.classList.remove('on')
      els.detailTitle.textContent = ''
      if (els.detailType) els.detailType.textContent = '节点详情'
      els.detailMeta.textContent = ''
      els.detailBody.textContent = ''
      return
    }
    els.detail.classList.add('on')
    els.detailTitle.textContent = truncate(point.label || point.id, 80)
    if (els.detailType) els.detailType.textContent = typeLabel(point.type)
    els.detailMeta.textContent = ''
    els.detailBody.textContent = ''

    var facts = el('div', 'facts')
    facts.appendChild(metaRow('节点 ID', shortId(point.id)))
    facts.appendChild(metaRow('时间', fmtTime(point.createdAt)))
    facts.appendChild(metaRow('重要性', fmtNumber(point.importance)))
    facts.appendChild(metaRow('激活度', fmtNumber(point.activation)))

    if (point.type === 'experience') {
      var experience = body && body.experience
      if (experience) {
        facts.appendChild(metaRow('来源', experience.sourceType))
        if (experience.role) facts.appendChild(metaRow('角色', experience.role))
        facts.appendChild(metaRow('观测时间', fmtTime(experience.observedAt)))
        els.detailBody.textContent = String(experience.content || '')
      }
      if (body && body.episode) {
        var chip = el('button', 'chip', '所属经历片段：' + truncate(body.episode.title || body.episode.id, 28))
        chip.addEventListener('click', function () { select(body.episode.id) })
        els.detailLinks.appendChild(chip)
      }
    } else if (point.type === 'episode') {
      var episode = (body && body.episode) || null
      if (episode) {
        facts.appendChild(metaRow('状态', episode.status))
        facts.appendChild(metaRow('开始', fmtTime(episode.startedAt)))
        facts.appendChild(metaRow('结束', fmtTime(episode.endedAt)))
        facts.appendChild(metaRow('成员经历', (body.stats && body.stats.experienceCount) || (episode.experienceIds || []).length))
        facts.appendChild(metaRow('证据记忆', body.stats ? body.stats.memoryCount : 0))
        if (episode.summary) {
          els.detailBody.textContent = String(episode.summary)
        } else {
          els.detailBody.textContent = '（该片段还没有摘要）'
        }
      }
      if (body && body.experiences && body.experiences.length) {
        var listTitle = el('div', 'section', '成员经历（点击查看正文）')
        els.detailLinks.appendChild(listTitle)
        var list = el('div', 'chips')
        body.experiences.forEach(function (item) {
          var button = el('button', 'chip', truncate(item.contentPreview || item.id, 34))
          button.title = fmtTime(item.createdAt) + ' · ' + item.sourceType
          button.addEventListener('click', function () { select(item.id) })
          list.appendChild(button)
        })
        els.detailLinks.appendChild(list)
      }
      if (body && body.memories && body.memories.length) {
        els.detailLinks.appendChild(el('div', 'section', '以这段经历为证据的长期记忆'))
        var memoryList = el('div', 'chips')
        body.memories.forEach(function (item) {
          var button = el('button', 'chip memory', truncate(item.content, 36))
          button.title = item.kind + ' · 置信度 ' + fmtNumber(item.confidence)
          button.addEventListener('click', function () { select(item.memoryId) })
          memoryList.appendChild(button)
        })
        els.detailLinks.appendChild(memoryList)
      }
      var continuity = (body && body.continuity) || (point.continuity) || null
      if (continuity && ((continuity.previous || []).length || (continuity.next || []).length)) {
        els.detailLinks.appendChild(el('div', 'section', '连续性（是关系，不是证据）'))
        ;(continuity.previous || []).forEach(function (relation) {
          var button = el('button', 'chip', '← ' + relation.relation + ' ' + shortId(relation.episodeId))
          button.title = relation.reason || ''
          button.addEventListener('click', function () { select(relation.episodeId) })
          els.detailLinks.appendChild(button)
        })
        ;(continuity.next || []).forEach(function (relation) {
          var button = el('button', 'chip', '→ ' + relation.relation + ' ' + shortId(relation.episodeId))
          button.title = relation.reason || ''
          button.addEventListener('click', function () { select(relation.episodeId) })
          els.detailLinks.appendChild(button)
        })
      }
    } else if (point.type === 'memory') {
      var memory = body && body.memory
      if (memory) {
        facts.appendChild(metaRow('类型', memory.kind))
        facts.appendChild(metaRow('状态', memory.status))
        facts.appendChild(metaRow('置信度', fmtNumber(memory.confidence)))
        facts.appendChild(metaRow('强化次数', memory.reinforcementCount))
        els.detailBody.textContent = String(memory.content || '')
      }
      var evidence = (body && body.evidence) || []
      if (evidence.length) {
        els.detailLinks.appendChild(el('div', 'section', '证据链（点击追溯原始经历）'))
        var evidenceList = el('div', 'chips')
        evidence.forEach(function (item) {
          var label = item.evidenceType === 'episode' ? '经历片段 ' : item.evidenceType === 'experience' ? '原始经历 ' : '知识 '
          var button = el('button', 'chip', label + shortId(item.evidenceId))
          button.title = item.relation
          button.addEventListener('click', function () { select(item.evidenceId) })
          evidenceList.appendChild(button)
        })
        els.detailLinks.appendChild(evidenceList)
      }
    } else if (point.type === 'pattern') {
      var pattern = body && body.pattern
      if (pattern) {
        facts.appendChild(metaRow('类型', pattern.kind))
        facts.appendChild(metaRow('状态', pattern.status))
        facts.appendChild(metaRow('支持数', pattern.supportCount))
        facts.appendChild(metaRow('置信度', fmtNumber(pattern.confidence)))
        els.detailBody.textContent = String(pattern.content || '')
      }
    }

    els.detailMeta.textContent = ''
    els.detailMeta.appendChild(facts)
  }

  // ---------------------------------------------------------------- 状态条

  function setStatus(text, isError) {
    els.status.textContent = text
    els.status.classList.toggle('error', Boolean(isError))
    if (els.statusBar) els.statusBar.classList.toggle('error', Boolean(isError))
  }

  // ---------------------------------------------------------------- 启动

  function setSettingsOpen(open) {
    state.settingsOpen = Boolean(open)
    if (!els.settingsPanel) return
    els.settingsPanel.hidden = !state.settingsOpen
    if (els.settingsToggle) els.settingsToggle.setAttribute('aria-expanded', state.settingsOpen ? 'true' : 'false')
  }

  // Stage 7：全景（所有 scope 的真实节点同屏）与单 scope 模式切换。
  function setMode(mode) {
    state.mode = mode === 'scope' ? 'scope' : 'global'
    var global = state.mode === 'global'
    if (els.modeGlobal) {
      els.modeGlobal.setAttribute('aria-pressed', global ? 'true' : 'false')
      els.modeGlobal.classList.toggle('on', global)
    }
    if (els.modeScope) {
      els.modeScope.setAttribute('aria-pressed', global ? 'false' : 'true')
      els.modeScope.classList.toggle('on', !global)
    }
    if (els.scopeFilterRow) els.scopeFilterRow.hidden = !global
    if (els.scopeRow) els.scopeRow.hidden = global
  }

  function switchMode(mode) {
    if (state.mode === mode) return
    setMode(mode)
    state.selectedId = null
    renderDetail(null)
    syncUrl()
    loadScene()
  }

  function bindEvents() {
    window.addEventListener('resize', function () { render() })
    canvas.addEventListener('pointerdown', function (event) {
      if (state.settingsOpen) setSettingsOpen(false)
      handlePointerDown(event)
    })
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault() })
    canvas.addEventListener('dblclick', function (event) {
      var rect = canvas.getBoundingClientRect()
      var hit = pick(event.clientX - rect.left, event.clientY - rect.top)
      if (hit) {
        // 双击节点 = 选中并聚焦；双击空白处仍然是复位视角
        select(hit.id)
        focusSelected()
      } else {
        resetView()
      }
    })

    if (els.settingsToggle) {
      els.settingsToggle.addEventListener('click', function () {
        setSettingsOpen(!state.settingsOpen)
      })
    }
    if (els.modeGlobal) {
      els.modeGlobal.addEventListener('click', function () { switchMode('global') })
    }
    if (els.modeScope) {
      els.modeScope.addEventListener('click', function () { switchMode('scope') })
    }
    els.scope.addEventListener('change', function () {
      state.scopeId = els.scope.value
      setMode('scope')
      loadScene()
      syncUrl()
    })
    els.reload.addEventListener('click', function () { loadScene() })
    els.reset.addEventListener('click', function () { resetView() })
    if (els.detailClose) els.detailClose.addEventListener('click', function () { select(null) })
    els.focus.addEventListener('click', function () { focusSelected() })
    els.search.addEventListener('input', function () {
      state.query = els.search.value
      render()
      updateStats()
    })
    ;['experience', 'episode', 'memory', 'pattern'].forEach(function (type) {
      els['filter_' + type].addEventListener('change', function (event) {
        state.filters[type] = Boolean(event.target.checked)
        render()
      })
    })
    document.addEventListener('keydown', function (event) {
      if (event.target && /input|select|textarea/i.test(event.target.tagName)) {
        if (event.key === 'Escape' && state.settingsOpen) setSettingsOpen(false)
        return
      }
      if (event.key === 'r' || event.key === 'R') resetView()
      if (event.key === 'f' || event.key === 'F') focusSelected()
      if (event.key === '/') {
        event.preventDefault()
        setSettingsOpen(true)
        window.setTimeout(function () { els.search.focus() }, 0)
      }
      if (event.key === 'Escape') {
        if (state.settingsOpen) { setSettingsOpen(false); return }
        select(null)
      }
    })
  }

  var RESUME_AUTO_ROTATE_MS = 1300
  var INERTIA_DECAY = 0.92
  var INERTIA_STOP = 0.00004

  function lerpValue(from, to, t) {
    return from + (to - from) * t
  }

  function stepCameraGoal(now) {
    var goal = state.cameraGoal
    if (!goal) return
    var t = Math.min(1, (now - goal.startedAt) / goal.duration)
    // easeInOutCubic
    var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    state.camera.target = {
      x: lerpValue(goal.fromTarget.x, goal.target.x, e),
      y: lerpValue(goal.fromTarget.y, goal.target.y, e),
      z: lerpValue(goal.fromTarget.z, goal.target.z, e),
    }
    state.camera.distance = lerpValue(goal.fromDistance, goal.distance, e)
    state.dirty = true
    if (t >= 1) state.cameraGoal = null
  }

  function loop() {
    var now = performance.now()
    stepCameraGoal(now)
    if (!state.dragging) {
      // 松手后的惯性：速度按帧衰减，转一小段后停下
      if (Math.abs(state.dragVelocity.yaw) > INERTIA_STOP || Math.abs(state.dragVelocity.pitch) > INERTIA_STOP) {
        state.camera.yaw += state.dragVelocity.yaw
        state.camera.pitch = wrapAngle(state.camera.pitch + state.dragVelocity.pitch)
        state.dragVelocity.yaw *= INERTIA_DECAY
        state.dragVelocity.pitch *= INERTIA_DECAY
        if (Math.abs(state.dragVelocity.yaw) <= INERTIA_STOP) state.dragVelocity.yaw = 0
        if (Math.abs(state.dragVelocity.pitch) <= INERTIA_STOP) state.dragVelocity.pitch = 0
        state.dirty = true
      }
      // 空闲 1.3 秒后重新开始缓慢自转（不会打断正在观察的选中/搜索）
      if (!state.autoRotate && state.points.length > 0 && now - state.lastInteractionAt > RESUME_AUTO_ROTATE_MS) {
        state.autoRotate = true
      }
    }
    if (state.autoRotate && state.points.length > 0) {
      state.camera.yaw += 0.000045
      state.dirty = true
    }
    if (state.dirty) render()
    window.requestAnimationFrame(loop)
  }

  function boot() {
    els = {
      settingsToggle: $('settings-toggle'),
      settingsPanel: $('settings-panel'),
      scope: $('scope'),
      scopeInfo: $('scope-info'),
      scopeCurrent: $('scope-current'),
      scopeNote: $('scope-note'),
      statNodes: $('stat-nodes'),
      statScopes: $('stat-scopes'),
      countExperience: $('count-experience'),
      countEpisode: $('count-episode'),
      countMemory: $('count-memory'),
      countPattern: $('count-pattern'),
      modeGlobal: $('mode-global'),
      modeScope: $('mode-scope'),
      scopeRow: $('scope-row'),
      scopeFilterRow: $('scope-filter-row'),
      scopeFilter: $('scope-filter'),
      reload: $('reload'),
      reset: $('reset'),
      focus: $('focus'),
      search: $('search'),
      dbPath: $('db-path'),
      status: $('status'),
      statusBar: $('statusbar'),
      detail: $('detail'),
      detailTitle: $('detail-title'),
      detailType: $('detail-type'),
      detailClose: $('detail-close'),
      edgeTooltip: $('edge-tooltip'),
      detailMeta: $('detail-meta'),
      detailBody: $('detail-body'),
      detailLinks: $('detail-links'),
      statExperiences: $('stat-experiences'),
      statEpisodes: $('stat-episodes'),
      statMemories: $('stat-memories'),
      statRelations: $('stat-relations'),
      statEdges: $('stat-edges'),
      filter_experience: $('filter-experience'),
      filter_episode: $('filter-episode'),
      filter_memory: $('filter-memory'),
      filter_pattern: $('filter-pattern'),
    }
    canvas = $('sea')
    ctx = canvas.getContext('2d')
    var initial = new URLSearchParams(window.location.search)
    if (initial.get('scope')) state.scopeId = initial.get('scope')
    if (initial.get('mode') === 'scope') state.mode = 'scope'
    var scopesParam = initial.get('scopes')
    if (scopesParam) {
      state.activeScopes = scopesParam.split(',').map(function (value) { return value.trim() }).filter(Boolean)
    }
    if (initial.get('q')) {
      state.query = initial.get('q')
      els.search.value = state.query
    }
    state.pendingSelect = initial.get('select') || ''
    // 仅用于自动化验收：带 ?debug=1 时暴露相机状态，方便断言旋转是否被限制。
    if (initial.get('debug') === '1' && typeof window !== 'undefined') {
      window.__memorySea = { state: state, camera: state.camera, wrapAngle: wrapAngle }
    }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) state.autoRotate = false
    bindEvents()
    setSettingsOpen(false)
    setMode(state.mode)
    setStatus('正在读取 scope…')
    loadDatabasePath()
    loadScopes()
      .then(function () { return loadScene() })
      .catch(function (error) {
        setStatus('初始化失败：' + (error && error.message ? error.message : error), true)
      })
    window.requestAnimationFrame(loop)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()

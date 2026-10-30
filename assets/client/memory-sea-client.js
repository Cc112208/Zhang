/**
 * dsh-3d-memory-sea — Memory Sea 浏览器半端（Stage 6 方案 A：主面板整页）
 * ============================================================================
 * 约定（从已安装的第三方插件 client bundle 学到，2026-10-30）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<package.json 的 name>',
 *       factory: require => ({ name, inject, apply })
 *     })
 *
 * 页面由两个座位拼成（缺一个都进不去）：
 *   · name: 'main', key: '<id>'                → 中间主面板整页
 *   · name: 'sidebar.panellist', id: '<id>'    → 左侧栏的入口行（点击切 main）
 * 两者用同一个 id，宿主按这个 id 把侧栏行和主面板配对。
 *
 * 本半端**只读**：只往同源 /api/memory-sea 与 /memory-sea/scene 发 GET，
 * 不碰 SQLite、不写任何数据。3D 渲染直接复用已验证的 /memory-sea/scene 页面
 * （iframe 内嵌，同源，因此共享登录态与相对路径，不需要额外接口）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-3d-memory-sea',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const PANEL_ID = 'memory-sea'
    const PAGE_PATH = '/memory-sea/atlas'

    const COLORS = {
      border: 'var(--dsw-alias-border-l2,rgba(255,255,255,.12))',
      base: 'var(--dsw-alias-bg-base,#12141a)',
      layer: 'var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06))',
      text: 'var(--dsw-alias-label-primary,#e6e8ee)',
      muted: 'var(--dsw-alias-label-tertiary,#9aa0a6)',
      accent: '#4aa3ff',
    }

    const Icon = ({ size = 18 }) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 12, cy: 7.5, r: 2.4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6.5, cy: 16, r: 1.9, fill: 'currentColor', stroke: 'none', opacity: 0.85 }),
        h('circle', { cx: 17.5, cy: 16, r: 1.9, fill: 'currentColor', stroke: 'none', opacity: 0.85 }),
        h('path', { d: 'M12 9.9 7.4 14.4M12 9.9l4.6 4.5M8.4 16h7.2', opacity: 0.75 }),
      )

    const buttonStyle = {
      font: 'inherit',
      fontSize: 12,
      color: COLORS.text,
      background: COLORS.layer,
      border: 1 + 'px solid ' + COLORS.border,
      borderRadius: 8,
      padding: '5px 10px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function ScenePage() {
      const frameRef = useRef(null)
      const [nonce, setNonce] = useState(0)
      const [ready, setReady] = useState(false)
      const [failed, setFailed] = useState('')

      useEffect(() => {
        const timer = setTimeout(() => {
          if (!ready) setFailed('页面加载超时：请确认 Memory Sea 插件已启用，然后点「刷新」。')
        }, 12000)
        return () => clearTimeout(timer)
      }, [ready, nonce])

      const reload = () => {
        setFailed('')
        setReady(false)
        setNonce((value) => value + 1)
      }

      const openStandalone = () => {
        const url = location.origin + PAGE_PATH
        if (window.open) window.open(url, '_blank', 'noopener')
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: COLORS.base,
            color: COLORS.text,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderBottom: '1px solid ' + COLORS.border,
              flex: 'none',
            },
          },
          h(Icon, { size: 16 }),
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '记忆海 · 3D Memory Sea'),
          h(
            'div',
            { style: { fontSize: 11, color: COLORS.muted } },
            '真实数据（Experience / Episode / Memory / Pattern）· 只读',
          ),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', style: buttonStyle, onClick: reload }, '刷新'),
          h('button', { type: 'button', style: buttonStyle, onClick: openStandalone }, '新标签打开'),
        ),
        failed
          ? h(
              'div',
              { style: { padding: '12px 14px', fontSize: 12, color: '#f59e0b' } },
              failed,
              h(
                'button',
                { type: 'button', style: { ...buttonStyle, marginLeft: 10 }, onClick: reload },
                '重试',
              ),
            )
          : null,
        h('iframe', {
          key: nonce,
          ref: frameRef,
          title: '3D Memory Sea',
          src: PAGE_PATH,
          onLoad: () => {
            setReady(true)
            setFailed('')
          },
          style: {
            flex: 1,
            width: '100%',
            minHeight: 0,
            border: 0,
            display: 'block',
            background: COLORS.base,
          },
        }),
      )
    }

    const name = 'memory-sea-view'
    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots || typeof slots.register !== 'function') {
        console.warn('[memory-sea-view] 宿主没有 slots 服务，三维页面未注册（其余功能不受影响）')
        return
      }
      // register 返回的 disposer 不保证是函数（slot 契约没有承诺），统一包一层。
      const safe = (off) => (typeof off === 'function' ? off : () => {})
      const offs = []
      const register = (slotName, factory) => {
        try {
          if (typeof slots.inject === 'function') {
            offs.push(safe(slots.inject(slotName, () => safe(factory()))))
          } else {
            offs.push(safe(factory()))
          }
        } catch (error) {
          console.error('[memory-sea-view] 注册 ' + slotName + ' 失败：', error)
        }
      }
      // 侧栏图标：id 与 main 面板的 key 同名，点它就会切到我们的面板。
      register('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => '记忆海' },
          (owner = {}) => h(Icon, { size: owner.size || 18 }),
        ),
      )
      register('main', () => slots.register({ name: 'main', key: PANEL_ID }, () => h(ScenePage)))
      return () => {
        for (const off of offs) {
          try {
            off()
          } catch (error) {
            console.warn('[memory-sea-view] 注销失败：', error)
          }
        }
      }
    }

    return { name, inject, apply }
  },
})

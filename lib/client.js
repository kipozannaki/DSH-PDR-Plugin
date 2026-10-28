/**
 * DSH-PDR · 插件行为监控面板（client 半边）
 *
 * 加载契约（宿主 web 端从 dsh.client 声明解析到本文件的 ./client 导出）。
 * 脚本必须是**顶层调用** window.__ModuleLoader__.load({id, factory(require)})：
 *   - factory 收到宿主的 require（react 由宿主模块表提供）
 *   - factory 内部建 module.exports 并 return —— 宿主在首次 import 时物化并缓存
 *   - CSS 注入也放在 factory 闭包里（模块体的副作用都在物化时发生）
 * 面板挂点：ctx.slots.inject('conversation.view', () => ctx.slots.register({
 *   name, id, order, locale, label }, props => React.createElement(View, props)))
 * —— order 30 排在 Chat(0) / Trajectory(10) / Context(20) 之后。
 *
 * 数据源：POST /api/dsh-pdr/events 与 /api/dsh-pdr/overview（panel-host.js 注册的
 * connection.fetch 路由）。
 */
window.__ModuleLoader__.load({ id: 'dsh-pdr-plugin', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require('react');
  var h = React.createElement;
  var NS = 'dsh-pdr-plugin';
  var VIEW_ID = 'pdr-monitor';
  var EVENTS_ROUTE = '/api/dsh-pdr/events';
  var OVERVIEW_ROUTE = '/api/dsh-pdr/overview';

  // ---------- 样式注入（物化时执行一次；data-plugin-css 标记防重） ----------
  var CSS = [
    '.pdr-wrap{--pdr-card:#ffffff;--pdr-line:#e5e7eb;--pdr-text:#111827;--pdr-muted:#6b7280;',
    '  --pdr-bg:#f9fafb;--pdr-ok:#059669;--pdr-warn:#d97706;--pdr-bad:#dc2626;--pdr-info:#2563eb;',
    '  padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px;',
    '  color:var(--pdr-text);font-size:14px;line-height:1.45;}',
    '@media (prefers-color-scheme: dark){.pdr-wrap{--pdr-card:#1f2430;--pdr-line:#374151;',
    '  --pdr-text:#e5e7eb;--pdr-muted:#9ca3af;--pdr-bg:#111827;}}',
    '.pdr-card{background:var(--pdr-card);border:1px solid var(--pdr-line);border-radius:12px;padding:14px 18px;}',
    '.pdr-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}',
    '.pdr-title{font-size:17px;font-weight:600;margin:0;}',
    '.pdr-sub{color:var(--pdr-muted);font-size:12px;}',
    '.pdr-btn{border:1px solid var(--pdr-line);background:var(--pdr-card);color:var(--pdr-text);',
    '  border-radius:8px;padding:4px 14px;font-size:13px;cursor:pointer;}',
    '.pdr-btn:hover{border-color:var(--pdr-info);color:var(--pdr-info);}',
    '.pdr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}',
    '.pdr-stat{background:var(--pdr-card);border:1px solid var(--pdr-line);border-radius:12px;padding:12px 16px;}',
    '.pdr-stat-num{font-size:24px;font-weight:700;letter-spacing:.2px;}',
    '.pdr-stat-label{font-size:12px;color:var(--pdr-muted);margin-top:2px;}',
    '.pdr-plugins{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;}',
    '.pdr-prow{background:var(--pdr-card);border:1px solid var(--pdr-line);border-radius:12px;padding:12px 16px;}',
    '.pdr-prow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
    '.pdr-pname{font-weight:600;font-size:14px;}',
    '.pdr-pname.is-host{color:var(--pdr-muted);font-weight:500;}',
    '.pdr-plast{margin-left:auto;font-size:12px;color:var(--pdr-muted);}',
    '.pdr-pstats{display:flex;gap:14px;margin-top:8px;flex-wrap:wrap;}',
    '.pdr-mini{font-size:12px;color:var(--pdr-muted);display:inline-flex;align-items:center;gap:5px;}',
    '.pdr-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}',
    '.pdr-dot.net{background:#10b981}.pdr-dot.fs{background:#3b82f6}.pdr-dot.sub{background:#f59e0b}',
    '.pdr-dot.cred{background:#ef4444}.pdr-dot.total{background:#8b5cf6}',
    '.pdr-tag{font-size:11px;padding:1px 8px;border-radius:999px;font-weight:500;white-space:nowrap;}',
    '.pdr-tag-bad{background:rgba(220,38,38,.12);color:var(--pdr-bad);}',
    '.pdr-tag-warn{background:rgba(217,119,6,.12);color:var(--pdr-warn);}',
    '.pdr-tag-info{background:rgba(37,99,235,.12);color:var(--pdr-info);}',
    '.pdr-tag-ok{background:rgba(5,150,105,.12);color:var(--pdr-ok);}',
    '.pdr-timeline{display:flex;flex-direction:column;}',
    '.pdr-ev{display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid var(--pdr-line);',
    '  font-size:12.5px;min-width:0;}',
    '.pdr-ev:last-child{border-bottom:none;}',
    '.pdr-ev.t-red{background:rgba(220,38,38,.05);border-radius:6px;}',
    '.pdr-ev-t{color:var(--pdr-muted);font-variant-numeric:tabular-nums;flex:0 0 64px;}',
    '.pdr-ev-actor{flex:0 0 170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.pdr-ev-api{flex:0 0 150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    '  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;}',
    '.pdr-ev-target{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pdr-muted);min-width:0;}',
    '.pdr-ev.t-red .pdr-ev-target{color:var(--pdr-bad);}',
    '.pdr-empty{color:var(--pdr-muted);padding:24px 0;text-align:center;font-size:13px;}',
    '.pdr-err{background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.35);border-radius:10px;',
    '  padding:14px 16px;color:var(--pdr-text);font-size:13px;}',
    '.pdr-err .pdr-muted{margin-top:6px;}',
    '.pdr-section{font-size:13px;font-weight:600;color:var(--pdr-muted);margin-top:6px;}',
    '.pdr-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--pdr-muted);cursor:pointer;user-select:none;}',
    '.pdr-toggle input{accent-color:var(--pdr-info);}',
  ].join('\n');
  try {
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="dsh-pdr-plugin/panel"]')) {
      var tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', 'dsh-pdr-plugin/panel');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
  } catch (e) { /* 无 DOM 环境忽略 */ }

  // ---------- 工具 ----------
  function post(route, body) {
    return fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) return j.value;
      throw new Error((j && j.error && j.error.message) || 'request failed');
    });
  }

  function fmtN(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }
  function fmtTime(t) {
    if (!t) return '—';
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function apiClass(api) {
    if (/^https?:|^fetch|^net\.|^(http|https)\./.test(api)) return 'net';
    if (/^child_process|exec|spawn/.test(api)) return 'sub';
    if (/credential/i.test(api)) return 'cred';
    return 'fs';
  }
  function redsOf(e) {
    return (e.redLines && e.redLines.length) ? e.redLines : (e.redLine ? [e.redLine] : []);
  }

  // ---------- 数据 ----------
  function usePdrData() {
    var st = React.useState({ loading: true, error: null, overview: null, events: [] });
    var data = st[0], setData = st[1];
    var tickSt = React.useState(0);
    var tick = tickSt[1];
    React.useEffect(function () {
      var alive = true;
      function load() {
        if (!alive) return;
        Promise.all([post(OVERVIEW_ROUTE), post(EVENTS_ROUTE, { limit: 300 })])
          .then(function (rs) {
            if (!alive) return;
            // events 路由的 value 就是事件数组本身（不是 {events:[…]} 包一层）
            setData({ loading: false, error: null, overview: rs[0], events: Array.isArray(rs[1]) ? rs[1] : [] });
          })
          .catch(function (e) {
            if (!alive) return;
            setData({ loading: false, error: String(e && e.message || e), overview: null, events: [] });
          });
      }
      load();
      var timer = setInterval(load, 5000);
      return function () { alive = false; clearInterval(timer); };
    }, []);
    return { data: data, refresh: function () { tick(function (n) { return n + 1; }); } };
  }

  // ---------- 组件 ----------
  function StatCard(props) {
    return h('div', { className: 'pdr-stat' },
      h('div', { className: 'pdr-stat-num' }, props.value),
      h('div', { className: 'pdr-stat-label' }, props.label));
  }

  function Tag(props) {
    var map = {
      boundary: ['越界', 'pdr-tag-bad'],
      suspicious: ['可疑', 'pdr-tag-warn'],
      observe: ['观察', 'pdr-tag-info'],
      normal: ['正常', 'pdr-tag-ok'],
    };
    var row = map[props.verdict] || map.normal;
    return h('span', { className: 'pdr-tag ' + row[1] }, props.text || row[0]);
  }

  function Dot(props) { return h('span', { className: 'pdr-dot ' + props.kind }); }

  function PluginCard(props) {
    var p = props.p;
    var isHost = p.name === 'host';
    var cats = [
      ['total', '总事件', 'total'], ['network', '网络', 'net'], ['fs', '文件', 'fs'],
      ['subprocess', '子进程', 'sub'], ['credentials', '凭据', 'cred'],
    ];
    return h('div', { className: 'pdr-prow' },
      h('div', { className: 'pdr-prow-head' },
        h('span', { className: 'pdr-pname' + (isHost ? ' is-host' : '') }, p.name),
        p.judge ? h(Tag, { verdict: p.judge.verdict, text: p.judge.zh }) : null,
        (p.redLines || []).map(function (r) { return h('span', { key: r, className: 'pdr-tag pdr-tag-bad' }, r); }),
        h('span', { className: 'pdr-plast' }, fmtTime(p.lastAt))),
      h('div', { className: 'pdr-pstats' },
        cats.map(function (c) {
          return h('span', { key: c[0], className: 'pdr-mini' },
            h(Dot, { kind: c[2] }), c[1] + ' ' + fmtN(p[c[0]]));
        })));
  }

  function EventRow(props) {
    var e = props.e;
    var red = redsOf(e);
    return h('div', { className: 'pdr-ev' + (red.length ? ' t-red' : '') },
      h('span', { className: 'pdr-ev-t' }, fmtTime(e.t)),
      h('span', { className: 'pdr-ev-actor', title: e.actor }, e.actor || '?'),
      h('span', { className: 'pdr-ev-api' }, e.api || ''),
      h('span', { className: 'pdr-ev-target', title: e.target || '' }, String(e.target || '').slice(0, 160)),
      red.length ? h('span', { className: 'pdr-tag pdr-tag-bad' }, red[0]) : null);
  }

  function MonitorView() {
    var r = usePdrData();
    var d = r.data;
    var filterSt = React.useState(false);
    var redOnly = filterSt[0], setRedOnly = filterSt[1];
    if (d.loading) {
      return h('div', { className: 'pdr-wrap' }, h('div', { className: 'pdr-empty' }, '加载中…'));
    }
    if (d.error) {
      return h('div', { className: 'pdr-wrap' },
        h('div', { className: 'pdr-err' },
          h('div', null, h('b', null, '行为监控数据通道未接入'), '：', d.error),
          h('div', { className: 'pdr-muted' }, '归因依赖 dsh-pdr 启动器启动宿主；Desktop 应用会话不在覆盖范围。体检卡与离线 audit/aggregate 不受影响。')));
    }
    var o = d.overview || {};
    var st = o.stats || {};
    var plugins = (o.plugins || []).filter(function (p) { return p.total > 0; });
    var hostRow = plugins.find(function (p) { return p.name === 'host'; });
    var pluginRows = plugins.filter(function (p) { return p.name !== 'host'; });
    var events = redOnly ? d.events.filter(function (e) { return redsOf(e).length > 0; }) : d.events;
    return h('div', { className: 'pdr-wrap' },
      h('div', { className: 'pdr-head' },
        h('div', null,
          h('h3', { className: 'pdr-title' }, '插件行为监控'),
          h('div', { className: 'pdr-sub' }, '按插件归属的运行时行为 · 5 秒自动刷新 · 数据仅存本机')),
        h('button', { className: 'pdr-btn', onClick: r.refresh }, '刷新')),
      h('div', { className: 'pdr-grid' },
        h(StatCard, { label: '事件总数', value: fmtN(st.totalEvents) }),
        h(StatCard, { label: '红线告警', value: fmtN(o.redFlagCount) }),
        h(StatCard, { label: '已拦截', value: fmtN(st.blocked) }),
        h(StatCard, { label: '监控插件', value: fmtN(pluginRows.length) }),
        h(StatCard, { label: '探针模式', value: st.mode || '—' }),
        h(StatCard, { label: '归因钩子', value: st.registryHooked ? '已就位' : '未挂载' })),
      pluginRows.length
        ? h('div', { className: 'pdr-plugins' }, pluginRows.map(function (p, i) { return h(PluginCard, { key: i, p: p }); }))
        : h('div', { className: 'pdr-card' }, h('div', { className: 'pdr-empty' }, '暂无插件行为记录')),
      hostRow
        ? h('div', { className: 'pdr-card' },
            h('div', { className: 'pdr-prow-head' },
              h('span', { className: 'pdr-pname is-host' }, 'host（宿主自身，不计红线）'),
              h('span', { className: 'pdr-plast' }, fmtTime(hostRow.lastAt))),
            h('div', { className: 'pdr-pstats' },
              h('span', { className: 'pdr-mini' }, h(Dot, { kind: 'total' }), '总事件 ' + fmtN(hostRow.total)),
              h('span', { className: 'pdr-mini' }, h(Dot, { kind: 'fs' }), '文件 ' + fmtN(hostRow.fs)),
              h('span', { className: 'pdr-mini' }, h(Dot, { kind: 'net' }), '网络 ' + fmtN(hostRow.network))))
        : null,
      h('div', { className: 'pdr-head', style: { marginTop: '4px' } },
        h('div', { className: 'pdr-section' }, '行为时间线 · 最近 ' + fmtN(events.length) + ' 条'),
        h('label', { className: 'pdr-toggle' },
          h('input', { type: 'checkbox', checked: redOnly, onChange: function (ev) { setRedOnly(ev.target.checked); } }),
          '只看红线')),
      events.length
        ? h('div', { className: 'pdr-card pdr-timeline' }, events.map(function (e, i) { return h(EventRow, { key: i, e: e }); }))
        : h('div', { className: 'pdr-card' }, h('div', { className: 'pdr-empty' }, redOnly ? '该过滤下暂无红线事件' : '暂无事件')));
  }

  function apply(ctx) {
    var slots = ctx.slots;
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
    // 与 dsh-context 相同的挂点；order 30 排在 Chat(0)/Trajectory(10)/Context(20) 之后。
    ctx.effect(function () {
      return slots.inject('conversation.view', function () {
        return slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 30,
          locale: NS,
          label: function () { return '行为监控'; },
        }, function () { return h(MonitorView); });
      });
    }, 'dsh-pdr-plugin: monitor tab');
  }

  module.exports = { name: NS, inject: ['slots'], apply: apply };
  return module.exports;
} });

/**
 * DSH-PDR · 插件行为监控面板（client 半边）
 *
 * 加载契约（与 dsh-context 的 client bundle 相同，宿主 web 端从 dsh.client 声明解析到
 * 本文件的 ./client 导出，包进 window.__ModuleLoader__.load({id, factory(require)})）：
 *   module.exports = { name, inject: ['slots', 'locale'], apply(ctx) }
 *
 * 面板挂点：ctx.slots.inject('conversation.view', () => ctx.slots.register({
 *   name, id, order, locale, label }, props => React.createElement(View, props)))
 * —— order 30 排在 Chat(0) / Trajectory(10) / Context(20) 之后。
 *
 * 数据源：POST /api/dsh-pdr/events 与 /api/dsh-pdr/overview（panel-host.js 注册的
 * connection.fetch 路由）。所有渲染走宿主注入的 React（factory 的 require 提供），
 * 本文件零依赖、零构建。
 */
(function (require) {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require('react');
  var h = React.createElement;
  var NS = 'dsh-pdr-plugin';
  var VIEW_ID = 'pdr-monitor';
  var EVENTS_ROUTE = '/api/dsh-pdr/events';
  var OVERVIEW_ROUTE = '/api/dsh-pdr/overview';

  // ---------- 数据获取（容错：通道缺位时面板显示说明而不是空白） ----------
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

  function fmtTime(t) {
    if (!t) return '—';
    var d = new Date(t);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function apiOf(target) { return String(target || '').slice(0, 60); }

  function apiClass(api) {
    if (/^https?:|^fetch|^net\.|^(http|https)\./.test(api)) return 'net';
    if (/^child_process|exec|spawn/.test(api)) return 'sub';
    if (/credential/i.test(api)) return 'cred';
    return 'fs';
  }

  // ---------- 组件 ----------
  function usePdrData() {
    var state = React.useState({ loading: true, error: null, overview: null, events: [] });
    var data = state[0], setData = state[1];
    var tick = React.useState(0)[1];
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

  function StatBox(props) {
    return h('div', { className: 'pdr-stat' },
      h('div', { className: 'pdr-stat-num' }, String(props.value)),
      h('div', { className: 'pdr-stat-label' }, props.label));
  }

  function VerdictTag(props) {
    var v = props.verdict || 'normal';
    var map = {
      boundary: ['越界', 'pdr-tag-bad'],
      suspicious: ['可疑', 'pdr-tag-warn'],
      observe: ['观察', 'pdr-tag-info'],
      normal: ['正常', 'pdr-tag-ok'],
    };
    var row = map[v] || map.normal;
    return h('span', { className: 'pdr-tag ' + row[1] }, props.zh || row[0]);
  }

  function PluginRow(props) {
    var p = props.p;
    var bands = [
      ['total', '总事件'],
      ['network', '网络'],
      ['fs', '文件'],
      ['subprocess', '子进程'],
      ['credentials', '凭据'],
    ];
    return h('div', { className: 'pdr-plugin-row' },
      h('div', { className: 'pdr-plugin-head' },
        h('span', { className: 'pdr-plugin-name' }, p.name),
        p.judge ? h(VerdictTag, { verdict: p.judge.verdict, zh: p.judge.zh }) : null,
        p.redLines && p.redLines.length
          ? h('span', { className: 'pdr-tag pdr-tag-bad' }, p.redLines.join(' / '))
          : null,
        h('span', { className: 'pdr-plugin-last' }, fmtTime(p.lastAt))),
      h('div', { className: 'pdr-plugin-stats' },
        bands.map(function (b) {
          return h('span', { key: b[0], className: 'pdr-mini' + (b[0] === 'credentials' && p.credentials ? ' pdr-mini-cred' : '') },
            b[1] + ' ' + (p[b[0]] || 0));
        })));
  }

  function EventRow(props) {
    var e = props.e;
    var cls = 'pdr-ev pdr-ev-' + apiClass(e.api);
    if (e.redLine || (e.redLines && e.redLines.length)) cls += ' pdr-ev-red';
    return h('div', { className: cls },
      h('span', { className: 'pdr-ev-t' }, fmtTime(e.t)),
      h('span', { className: 'pdr-ev-actor' }, e.actor || '?'),
      h('span', { className: 'pdr-ev-api' }, e.api || ''),
      h('span', { className: 'pdr-ev-target', title: e.target || '' }, apiOf(e.target)),
      (e.redLines && e.redLines.length) || e.redLine
        ? h('span', { className: 'pdr-tag pdr-tag-bad' }, (e.redLines && e.redLines[0]) || e.redLine)
        : null);
  }

  function MonitorView() {
    var r = usePdrData();
    var d = r.data;
    if (d.loading) {
      return h('div', { className: 'pdr-wrap' }, h('div', { className: 'pdr-empty' }, '加载中…'));
    }
    if (d.error) {
      return h('div', { className: 'pdr-wrap' },
        h('div', { className: 'pdr-empty' },
          h('div', null, '行为监控数据通道未接入：', d.error),
          h('div', { className: 'pdr-muted' }, '请确认宿主由 dsh-pdr 启动器启动（Desktop 应用不在归因范围）。')));
    }
    var o = d.overview || {};
    var st = o.stats || {};
    var plugins = o.plugins || [];
    return h('div', { className: 'pdr-wrap' },
      h('div', { className: 'pdr-head' },
        h('div', { className: 'pdr-title' }, '插件行为监控'),
        h('button', { className: 'pdr-btn', onClick: r.refresh }, '刷新')),
      h('div', { className: 'pdr-stats' },
        h(StatBox, { label: '事件总数', value: st.totalEvents || 0 }),
        h(StatBox, { label: '红线告警', value: o.redFlagCount || 0 }),
        h(StatBox, { label: '已拦截', value: st.blocked || 0 }),
        h(StatBox, { label: '监控插件', value: plugins.length }),
        h(StatBox, { label: '探针模式', value: st.mode || '—' }),
        h(StatBox, { label: '归因钩子', value: st.registryHooked ? '已就位' : '未挂载' })),
      plugins.length
        ? h('div', { className: 'pdr-plugins' }, plugins.map(function (p, i) { return h(PluginRow, { key: i, p: p }); }))
        : h('div', { className: 'pdr-empty' }, '暂无插件行为记录'),
      h('div', { className: 'pdr-section' }, '行为时间线（最新 ' + d.events.length + ' 条，5 秒自动刷新）'),
      d.events.length
        ? h('div', { className: 'pdr-events' }, d.events.map(function (e, i) { return h(EventRow, { key: i, e: e }); }))
        : h('div', { className: 'pdr-empty' }, '暂无事件'));
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
})

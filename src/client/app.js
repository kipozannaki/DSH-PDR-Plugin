/**
 * 插件安全中心 · 前端（无框架、免构建）
 * 数据面：GET /api/firewall/overview | /events | /redflags | /export（契约见 api-handlers.mjs）
 * 形状与 probe-core / trust-score 输出一致，演示数据与真实数据零改动切换。
 */
const $ = (sel) => document.querySelector(sel);
const state = { overview: null, events: [], selectedPlugin: '' };

const FLAG_LABEL = {
  'credentials-access': '凭据访问',
  'cleartext-http': '明文外联',
  subprocess: '子进程',
  redline: '红线',
  blocked: '已拦截',
};

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) ;
}

function fmtDay(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function load() {
  const [overview, events] = await Promise.all([
    fetchJSON('/api/firewall/overview'),
    fetchJSON('/api/firewall/events?limit=500'),
  ]);
  state.overview = overview;
  state.events = events.events ?? events;
  render();
}

function render() {
  const ov = state.overview;
  if (!ov) return;

  $('#demo-badge').classList.toggle('hidden', !ov.demo);
  $('#probe-chip').textContent = ov.stats?.installed
    ? `探针运行中 · ${ov.stats.mode ?? 'monitor'}`
    : '探针未安装';

  // 统计卡
  $('#stat-plugins').textContent = ov.plugins.length;
  $('#stat-redlines').textContent = ov.redFlags.length;
  $('#stat-events').textContent = ov.stats?.totalEvents ?? state.events.length;
  $('#stat-blocked').textContent = ov.plugins.filter((p) => p.verdict === 'BLOCK').length;

  renderPluginList(ov.plugins);
  renderRedlineBanner(ov.redFlags);
  renderEvents();
  populatePluginFilter(ov.plugins);
}

function renderPluginList(plugins) {
  const host = $('#plugin-list');
  host.innerHTML = '';
  const sorted = [...plugins].sort((a, b) => a.trust.score - b.trust.score);
  for (const p of sorted) {
    const card = document.createElement('div');
    card.className = 'pcard' + (state.selectedPlugin === p.name ? ' selected' : '');
    card.innerHTML = `
      <div class="pcard-top">
        <span class="pcard-name">${p.name}</span>
        <span class="badge badge-${p.verdict}">${p.verdict}</span>
      </div>
      <div class="pcard-ver">v${p.version ?? '?'} · 信任分 ${p.trust.score}（${p.trust.band}）</div>
      <div class="trust-row">
        <div class="trust-bar"><div class="trust-fill ${p.trust.tone}" style="width:${p.trust.score}%"></div></div>
      </div>
      ${p.judge ? `<div class="judge-row">
        <span class="judge judge-${p.judge.verdict}">判定 ${p.judge.zh}</span>
        ${(p.judge.violations ?? []).map((v) => `<span class="rl-tag" title="${v.detail}">${v.rule}</span>`).join('')}
      </div>` : ''}
      <div class="caps">${p.capabilities.map((c) =>
        `<span class="cap ${c === 'credentials' ? 'cred' : (c === 'network' || c === 'shell' || c === 'dynamic-code') ? 'hot' : ''}">${c}</span>`
      ).join('')}</div>
      ${p.redLines.length ? `<div class="redline-tags">${p.redLines.map((r) => `<span class="rl-tag">⛔ ${r}</span>`).join('')}</div>` : ''}
      <div class="behavior-row">
        <span>net ${p.behavior.network}</span>
        <span>fs ${p.behavior.fs}</span>
        <span>proc ${p.behavior.subprocess}</span>
        <span>cred ${p.behavior.credentials}</span>
      </div>`;
    card.addEventListener('click', () => {
      state.selectedPlugin = state.selectedPlugin === p.name ? '' : p.name;
      $('#f-plugin').value = state.selectedPlugin;
      render();
    });
    host.appendChild(card);
  }
}

function renderRedlineBanner(redFlags) {
  const host = $('#redline-banner');
  if (!redFlags.length) { host.innerHTML = ''; return; }
  const byRule = redFlags.reduce((m, f) => ((m[f.rule] = (m[f.rule] || 0) + 1), m), {});
  host.innerHTML = `
    <div class="alert">
      <b>⛔ 红线告警 ${redFlags.length} 条</b>
      （${Object.entries(byRule).map(([r, n]) => `${r} ×${n}`).join('，')}）
      ${redFlags.slice(0, 4).map((f) =>
        `<div class="alert-row">${fmtTime(f.t)} · ${f.actor} · ${f.rule} · ${f.target}</div>`
      ).join('')}
    </div>`;
}

function populatePluginFilter(plugins) {
  const sel = $('#f-plugin');
  const current = sel.value;
  sel.innerHTML = '<option value="">全部插件</option>'
    + plugins.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
  sel.value = current || state.selectedPlugin || '';
}

function renderEvents() {
  const q = $('#f-search').value.trim().toLowerCase();
  const flag = $('#f-flag').value;
  const actor = $('#f-plugin').value || state.selectedPlugin;

  const redlineTargets = new Set((state.overview?.redFlags ?? [])
    .map((f) => `${f.actor}|${f.api}|${f.target}`));

  let rows = state.events;
  if (actor) rows = rows.filter((e) => e.actor === actor);
  if (flag === 'redline') {
    rows = rows.filter((e) => redlineTargets.has(`${e.actor}|${e.api}|${e.target}`));
  } else if (flag) {
    rows = rows.filter((e) => e.flags?.includes(flag));
  }
  if (q) rows = rows.filter((e) =>
    (e.target || '').toLowerCase().includes(q)
    || (e.api || '').toLowerCase().includes(q)
    || (e.actor || '').toLowerCase().includes(q));

  rows = [...rows].sort((a, b) => b.t - a.t).slice(0, 300);

  const tbody = $('#event-rows');
  tbody.innerHTML = rows.map((e) => {
    const isRedline = redlineTargets.has(`${e.actor}|${e.api}|${e.target}`);
    const flags = (e.flags ?? []).map((f) =>
      `<span class="flag ${f}">${FLAG_LABEL[f] ?? f}</span>`).join('')
      + (isRedline ? '<span class="flag redline">红线</span>' : '');
    return `<tr>
      <td class="t">${fmtDay(e.t)} ${fmtTime(e.t)}</td>
      <td class="actor">${e.actor}</td>
      <td class="api">${e.api}</td>
      <td class="target">${e.target ?? ''}</td>
      <td>${flags}</td>
    </tr>`;
  }).join('');
  $('#events-empty').classList.toggle('hidden', rows.length > 0);
}

async function exportReport() {
  const res = await fetch('/api/firewall/export');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dsh-firewall-audit-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// 事件绑定
$('#btn-refresh').addEventListener('click', () => load().catch(console.error));
$('#btn-export').addEventListener('click', () => exportReport().catch(console.error));
$('#f-search').addEventListener('input', () => renderEvents());
$('#f-flag').addEventListener('change', () => renderEvents());
$('#f-plugin').addEventListener('change', () => {
  state.selectedPlugin = $('#f-plugin').value;
  render();
});

load().catch((e) => {
  document.body.insertAdjacentHTML('beforeend',
    `<div class="alert" style="margin:20px">加载失败：${e.message}</div>`);
});

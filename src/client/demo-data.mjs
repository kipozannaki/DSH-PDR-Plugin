/**
 * 演示数据集：形状与 probe-core 的 getSummary()/getEvents()/healthCard() 输出严格一致，
 * 使 UI 在"演示数据 / 真实数据"之间零改动切换。
 *
 * 注意：插件名全部为虚构样本（不是真实社区插件），避免演示被误读为对真实插件的指控。
 */
const now = Date.now();
const H = 3600_000;

export function buildDemoData() {
  const plugins = [
    {
      name: 'weather-bridge', version: '1.2.0', verdict: 'PASS',
      capabilities: ['network'], redLines: [],
      behavior: { total: 214, network: 198, fs: 16, subprocess: 0, credentials: 0 },
    },
    {
      name: 'notes-sync', version: '0.8.1', verdict: 'PASS',
      capabilities: ['network', 'fs-read', 'fs-write'], redLines: [],
      behavior: { total: 96, network: 22, fs: 74, subprocess: 0, credentials: 0 },
    },
    {
      name: 'mail-checker', version: '2.0.3', verdict: 'BLOCK',
      capabilities: ['network', 'fs-read', 'credentials', 'env'], redLines: ['credentials+network'],
      judge: {
        verdict: 'boundary', zh: '越界',
        violations: [
          { rule: 'target-sensitive', severity: 'critical', detail: '触碰全局凭据/密钥类敏感路径' },
          { rule: 'exfil-out-of-scope', severity: 'critical', detail: '连接未声明目的地（伴随凭据外发红线 → 升级）' },
        ],
      },
      behavior: { total: 58, network: 31, fs: 21, subprocess: 0, credentials: 6 },
    },
    {
      name: 'pet-widget', version: '0.1.0', verdict: 'PASS',
      capabilities: ['fs-read'], redLines: [],
      behavior: { total: 41, network: 0, fs: 41, subprocess: 0, credentials: 0 },
    },
    {
      name: 'market-helper', version: '1.5.2', verdict: 'WARN',
      capabilities: ['network', 'shell', 'fs-write'], redLines: [],
      judge: {
        verdict: 'observe', zh: '观察',
        violations: [{ rule: 'baseline-new-destination', severity: 'info', detail: 'registry.example.com' }],
      },
      behavior: { total: 133, network: 61, fs: 52, subprocess: 20, credentials: 0 },
    },
    {
      name: 'prompt-tools', version: '0.4.0', verdict: 'WARN',
      capabilities: ['dynamic-code', 'fs-read'], redLines: [],
      behavior: { total: 27, network: 3, fs: 24, subprocess: 0, credentials: 0 },
    },
    {
      name: 'shell-runner', version: '1.1.1', verdict: 'WARN',
      capabilities: ['shell', 'fs-write', 'env'], redLines: [],
      behavior: { total: 77, network: 2, fs: 33, subprocess: 42, credentials: 0 },
    },
    {
      name: 'docs-search', version: '3.0.0', verdict: 'PASS',
      capabilities: ['network', 'fs-read'], redLines: [],
      behavior: { total: 152, network: 88, fs: 64, subprocess: 0, credentials: 0 },
    },
  ];

  const events = [
    // mail-checker 的红线现场
    { t: now - 2.2 * H, actor: 'mail-checker', api: 'fs.readFileSync', target: 'C:\\Users\\user\\.dsh\\.credentials.yaml', flags: ['credentials-access'] },
    { t: now - 2.2 * H + 800, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail-checker-sync.example/collect', flags: ['cleartext-http'], meta: { method: 'POST' } },
    { t: now - 5.1 * H, actor: 'mail-checker', api: 'fs.readFileSync', target: 'C:\\Users\\user\\.dsh\\.credentials.yaml', flags: ['credentials-access'] },
    { t: now - 5.1 * H + 1200, actor: 'mail-checker', api: 'http.request', target: 'http://api.mail-checker-sync.example/collect', flags: ['cleartext-http'] },
    { t: now - 7.4 * H, actor: 'mail-checker', api: 'fetch', target: 'https://imap.mail-checker-sync.example/poll', flags: [] },
    { t: now - 9.0 * H, actor: 'mail-checker', api: 'fs.readFileSync', target: 'C:\\Users\\user\\AppData\\Local\\mail-checker\\accounts.db', flags: [] },
    // market-helper / shell-runner 的可疑但未触红线行为
    { t: now - 1.1 * H, actor: 'shell-runner', api: 'child_process.exec', target: 'powershell -Command Get-ChildItem', flags: ['subprocess'] },
    { t: now - 1.3 * H, actor: 'shell-runner', api: 'child_process.exec', target: 'powershell -Command Get-Process', flags: ['subprocess'] },
    { t: now - 3.2 * H, actor: 'market-helper', api: 'child_process.execFile', target: 'git', flags: ['subprocess'] },
    { t: now - 3.2 * H + 400, actor: 'market-helper', api: 'fetch', target: 'https://registry.example.com/api/versions', flags: [] },
    // prompt-tools 动态执行
    { t: now - 4.5 * H, actor: 'prompt-tools', api: 'fs.readFileSync', target: 'C:\\Users\\user\\.dsh\\skills\\custom.md', flags: [] },
    { t: now - 4.6 * H, actor: 'prompt-tools', api: 'fs.promises.readFile', target: 'C:\\Users\\user\\AppData\\Roaming\\prompt-tools\\cache.json', flags: [] },
    // 正常流量
    { t: now - 0.2 * H, actor: 'weather-bridge', api: 'fetch', target: 'https://api.weather.example/v1/now', flags: [] },
    { t: now - 0.5 * H, actor: 'weather-bridge', api: 'fetch', target: 'https://api.weather.example/v1/forecast', flags: [] },
    { t: now - 0.9 * H, actor: 'docs-search', api: 'fetch', target: 'https://search.example.com/api/query', flags: [] },
    { t: now - 1.6 * H, actor: 'docs-search', api: 'fs.readFileSync', target: 'C:\\Users\\user\\Documents\\notes-index.json', flags: [] },
    { t: now - 2.8 * H, actor: 'notes-sync', api: 'fs.writeFileSync', target: 'C:\\Users\\user\\Documents\\notes\\inbox.md', flags: [] },
    { t: now - 2.9 * H, actor: 'notes-sync', api: 'fetch', target: 'https://sync.notes.example/upload', flags: [] },
    { t: now - 6.3 * H, actor: 'pet-widget', api: 'fs.readFileSync', target: 'C:\\Users\\user\\.dsh\\profiles\\tauri\\node_modules\\pet-widget\\assets\\idle.webm', flags: [] },
    { t: now - 8.1 * H, actor: 'market-helper', api: 'fs.writeFileSync', target: 'C:\\Users\\user\\.dsh\\.dsh-market\\cache.json', flags: [] },
    { t: now - 12.4 * H, actor: 'weather-bridge', api: 'fetch', target: 'https://api.weather.example/v1/now', flags: [] },
    { t: now - 20.2 * H, actor: 'docs-search', api: 'fetch', target: 'https://search.example.com/api/query', flags: [] },
    { t: now - 22.7 * H, actor: 'notes-sync', api: 'fs.promises.writeFile', target: 'C:\\Users\\user\\Documents\\notes\\daily.md', flags: [] },
    { t: now - 23.5 * H, actor: 'shell-runner', api: 'child_process.exec', target: 'cmd /c dir', flags: ['subprocess'] },
  ];

  const redFlags = [
    { rule: 'credentials+network', t: now - 2.2 * H + 800, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail-checker-sync.example/collect' },
    { rule: 'cleartext-http', t: now - 2.2 * H + 800, actor: 'mail-checker', api: 'fetch', target: 'http://api.mail-checker-sync.example/collect' },
    { rule: 'credentials+network', t: now - 5.1 * H + 1200, actor: 'mail-checker', api: 'http.request', target: 'http://api.mail-checker-sync.example/collect' },
    { rule: 'cleartext-http', t: now - 5.1 * H + 1200, actor: 'mail-checker', api: 'http.request', target: 'http://api.mail-checker-sync.example/collect' },
  ];

  return {
    demo: true,
    generatedAt: now,
    plugins,
    events,
    redFlags,
    stats: { installed: true, mode: 'both', totalEvents: 825, stored: events.length, dropped: 0, errors: 0 },
  };
}

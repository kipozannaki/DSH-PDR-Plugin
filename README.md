# DSH-PDR

**Plugin Detection and Response for DeepSeek Harness.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.12-339933.svg)](package.json)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.1.7-5B4CF0.svg)](package.json)

**English** · [中文](./README.zh.md)

---

Every plugin you install runs with the same privileges as the host: it can read your credentials,
open sockets, and spawn processes. Reviewing its source answers *what it could do* — and only
until the next update.

DSH-PDR answers a different question: **what did it actually do?**

It observes the process while it runs, attributes every `fs` / network / subprocess call to the
plugin that made it, judges that call against what the plugin claims to need, and shows you the
result. Everything stays on your machine.

- 🔍 **Pre-install health card** — static capability surface, red-line combinations, PASS / WARN / BLOCK
- 👁 **Runtime firewall** — per-plugin timeline of filesystem, network and subprocess activity
- ⚖️ **Boundary judge** — declared contract × path class × behaviour baseline; a plugin's day job is silent
- 🛑 **Block mode** (opt-in) — stop a call before it happens, not after
- 🔄 **Update guard** — capability diff plus an isolated trial install
- 📄 **Audit export** — JSON, Markdown, SARIF 2.1.0, CSV; offline, no host required
- 🔒 **Local-first** — no telemetry, ever

## Install

```bash
# 1. install into a profile
dsh plugin --profile <profile> add file:/path/to/dsh-pdr-plugin
#    or, from the repository:
dsh plugin --profile <profile> add github:kipozannaki/DSH-PDR-Plugin

# 2. start the host through the launcher (not `dsh` directly — see below)
dsh-pdr --profile <profile> web

# 3. confirm the preload is in place
dsh-pdr --pdr-check
```

Requirements: **Node ≥ 22.12** (for `require(esm)`), **DSH ≥ 0.1.7**.

> **Why the launcher?** A DSH host formalises several `node:*` ESM facades very early, so a probe
> installed from inside a plugin misses a large slice of calls. Measured on one real session:
> `earlyInstall` alone attributed **0 of 3** target-plugin calls (926 events, all fell back to
> `host`); adding the preload attributed **3 of 3** (5 192 events). The preload is a requirement,
> not an optimisation — [`docs/DESIGN.md`](./docs/DESIGN.md#timing-is-the-hard-constraint).

Nothing installed? The UI runs on demo data:

```bash
node src/client/serve.js        # http://127.0.0.1:3123/firewall/
```

## What it does

| Stage | Capability | Where |
|---|---|---|
| Before install | Health card: capability surface, red-line combinations, PASS / WARN / BLOCK | `src/inspector/` |
| Runtime | Behaviour probe: network / fs / subprocess, attributed per plugin | `src/probe/` |
| Runtime | Red-line alerts: credentials+network, credentials+subprocess, cleartext egress | `src/probe/` |
| Runtime | Boundary judge: contract × path class × baseline → normal / observe / suspicious / boundary | `src/judge/` |
| Runtime | Contract inference: observe a cold start → draft → human confirmation | `src/judge/infer.js` |
| Runtime | Block mode: pre-execution check, violation stopped in place (opt-in) | `src/guard/` |
| On change | Snapshot & rollback of the profile manifest trio | `src/store/snapshot.js` |
| On change | Update guard: capability diff + isolated trial install in a sandboxed child process | `src/update/` |
| Overview | Security-centre UI: plugin list, trust score, red-line banner, filterable timeline | `src/client/` |
| Overview | Audit report, SARIF / CSV compliance export, multi-source aggregation | `src/report/` |
| Overview | Red-line webhook push — off by default, deduped, rate-limited, never self-recording | `src/alert/` |

## Screenshot

![Security centre](./assets/security-center-demo.png)

```bash
node src/client/serve.js                     # demo data
node src/client/serve.js --jsonl <path>      # replay a real probe log ($DSH_HOME/firewall/events.jsonl)
```

Plain `index.html` + `app.js` + `style.css` — no framework, no build step. The standalone server and
the in-host mount share one route table (`src/client/api-handlers.mjs`), so the preview behaves
exactly like the mounted panel.

## How it works

```
config materialises ── earlyInstall expression installs the probe
        │
preload ────────────── dsh-pdr sets NODE_OPTIONS=--require …/preload.cjs  ← beats ESM facades
        │
probe ──────────────── layer 1 property patch + layer 2 binding patch
        │             attribution: ALS → stack walk → 'host'
judge / guard ──────── contract × path class × baseline → allow / alarm / block
        │
store / report ─────── JSONL on disk, audit export, optional webhook
```

The probe wraps `RegistryService.prototype.plugin` before any plugin is instantiated, so plugin
entry points run inside an `AsyncLocalStorage` context and every call they start is attributed —
including calls made through injected host services. This is the cheap path: measured on a real
session (~5 600 hooks), stack-based attribution costs ≈ 1.9 % of wall clock against ALS's
≈ 0.05 % (per-op: 114 µs vs 2.9 µs), so `als` is the default.

Full architecture, hook-coverage matrix and the honest list of residual gaps:
[`docs/DESIGN.md`](./docs/DESIGN.md).

## Configuration

```yaml
# the profile's cordis.patch.yml
- id: dsh-pdr-plugin
  config:
    dataDir: ~/.dsh/firewall     # default
    probeMode: als               # als (default) | stack (slower) | both
    maxBytes: 8388608            # rotate events.jsonl at 8 MB, keep 3
    policy:
      mode: alarm                # alarm (default) | block
      rules:
        credential-exfil: block
    alerts:
      enabled: false             # off: not one byte leaves the machine
      url: https://your-webhook.example/hook
      rules: []                  # empty = every red line
      format: json               # json | slack | dingtalk
```

### Declaring a contract (optional, for plugin authors)

```jsonc
// package.json
"firewall": {
  "hosts": ["api.example.com"],     // declared destinations; going outside → scope violation
  "grants": ["global-credentials"]  // explicit authorisation for sensitive targets
}
```

A contract is **declared freedom**: staying inside it is silent, leaving it is recorded. When
nothing is declared, the contract is derived from the health card's capability surface.

## CLI

```bash
dsh-pdr web                        # = dsh web, with the preload
dsh-pdr headless "run tests"       # any dsh subcommand
dsh-pdr --pdr-check                # print which preload is in use

# offline export — no host, no hooks, just reads the JSONL
dsh-pdr audit --format md
dsh-pdr audit --format sarif --out audit.sarif
dsh-pdr audit --format csv   --out audit.csv
dsh-pdr audit --format json  --out audit.json

# multi-source aggregation (several profiles / machines / archives)
dsh-pdr aggregate --format md
dsh-pdr aggregate --source prod=/m1/.dsh/firewall --source dev=/m2/.dsh/firewall
```

`aggregate` reads rotated files too (`events.jsonl.1/.2/.3`), de-duplicates across sources and
reports the counts, and counts unparsable lines instead of dropping them silently. Measured on 4
files / 127 000 events: 1 252 duplicates found.

## API

Other plugins can inject the `firewall` service:

```js
const api = ctx.firewall;

api.getEvents({ actor: 'some-plugin', flag: 'credentials-access', limit: 100 });
api.getRedFlags();                 // red-line alerts
api.getSummary();                  // per-plugin counts + red lines + probe health
api.healthCard(pluginDir);         // static card: PASS / WARN / BLOCK
api.getVerdicts();                 // boundary verdicts + contracts
api.inferContracts();              // drafts from observed behaviour (never auto-applied)
api.adoptContract(name);           // confirm a draft
api.setPolicy({ rules: { 'credential-exfil': 'block' } });
api.getUpdateDiff(before, after);  // what changed in this update
api.trialInstall(pluginDir);       // isolated trial, crash/hang contained
api.getAuditReport();              // JSON report
api.getSarif(); api.getCsv();      // compliance formats
api.eventLogPath;                  // local JSONL — nothing is uploaded
```

## Privacy

- Events, snapshots, contracts and health cards live in `$DSH_HOME/firewall/`. **No telemetry.**
- The only outbound path is a webhook **you** configure. It is off by default, sends red-line
  events only — never the full timeline, never file contents, never credentials.
- The plugin holds itself to its own standard: no credential access, no silent network.

## Limitations

Stated plainly, because a security tool that overstates its coverage is worse than none:

- **Heuristic, not a proof.** A static scan cannot see credentials injected at runtime; that is
  what the runtime layer is for. On 154 real ecosystem plugins the static pass recalls 66.1 % at
  17.2 % false positives.
- **Not an adversarial sandbox.** A plugin that deliberately targets the instrumentation
  (native modules, `process.binding`, patching the probe) can evade it. The goal is continuous,
  attributable visibility.
- **Known gaps** — named imports of `child_process` / `http` / `net` when the facade predates the
  probe. `fs` is covered on both hook layers.
- **In-host web mount is unverified.** The `dsh-h3` adapter follows a contract measured on a live
  community plugin and is covered by 11 injected-runtime assertions, but `dsh-h3` is a Typert
  virtual module that cannot be resolved offline. Until it is verified in a live host the panel
  falls back to `serve.js`.
- **upstream-radar integration is not done.** We emit `dsh-pdr-compat/1`; their schema is not
  public, so mapping it is still outstanding.

## Development

```bash
npm test              # all 22 suites (PASS / SKIP / FAIL; any failure exits 1)
npm run test:list     # what would run
node test/smoke.mjs   # one suite
```

Suites that need a real environment (a real plugin, a profile, an external baseline) print
`SKIP: <reason>` and how to restore them, and exit 0. They never pretend to pass. Any failing
assertion exits 1.

What each suite covers: [`docs/TESTING.md`](./docs/TESTING.md).

### Updating an installed copy

`file:` dependencies are **copied** into the profile, not symlinked — changing code or bumping the
version does not reach it, and `add` answers "Already up to date". Remove then add:

```bash
dsh plugin --profile <p> remove dsh-pdr-plugin
dsh plugin --profile <p> add file:/path/to/dsh-pdr-plugin
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/DESIGN.md`](./docs/DESIGN.md) | architecture, attribution, hook coverage, residual gaps |
| [`docs/TESTING.md`](./docs/TESTING.md) | every suite, what it asserts, environment variables |
| [`docs/LESSONS.md`](./docs/LESSONS.md) | findings that changed the implementation |

## License

MIT — see [LICENSE](./LICENSE).

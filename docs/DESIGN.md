# Design

## The problem this solves

Every plugin you install into DSH runs with the same privileges as the host: it can read your
credentials, open sockets, spawn processes. Reviewing source code before installing answers
"what *could* it do", and it answers it only until the next update. DSH-PDR answers a different
question — "what *did* it do" — by observing the process while it runs and attributing each
observation to the plugin that made the call.

Visibility is the product. Blocking is an optional, off-by-default addition on top.

## Pipeline

```
cordis.patch.yml ── earlyInstall expression (hooks installed while config materialises)
        │
src/index.js ────── assemble: probe → plugin identity registry → JSONL → API
        │
src/probe/probe-core.cjs ── two hook layers + three-tier attribution + ring buffer + rules
        ├─ layer 1, property patch: fs / fs.promises / child_process / http / https / net / tls / fetch
        ├─ layer 2, binding patch:  fs.readFileUtf8, fs.open, fs.writeFileUtf8/writeBuffer/…
        └─ attribution: ALS fast path → stack walk (file:// normalisation + dir map) → 'host'
        │
src/judge/ ─────── contract × path class × behaviour baseline → 正常 / 观察 / 可疑 / 越界
src/guard/ ─────── pre-execution policy check → allow / alarm / block
src/store/ ─────── JSONL events, profile snapshots
src/report/ ────── audit report, SARIF / CSV export, multi-source aggregation
src/alert/ ─────── optional red-line webhook (off by default)
src/client/ ────── security-centre UI + HTTP contract shared by the standalone server and the host
```

## Timing is the hard constraint

An ESM module that imports `node:fs` gets a **snapshot of the function** at import time. Patching
the property later changes what `require()` sees and leaves already-imported named bindings
pointing at the original. The real DSH host formalises several `node:*` facades very early in
startup, so a probe installed from a plugin entry point misses a large slice of calls.

Measured, same session, with and without the preload:

| Setup | Events | Target-plugin attribution |
|---|---|---|
| `earlyInstall` only | 926 | 0 / 3 — everything fell back to `host` |
| `dsh-pdr` preload + `earlyInstall` | 5 192 | 3 / 3 |

So the preload is a **requirement**, not an optimisation. `dsh-pdr` is a thin launcher that sets
`NODE_OPTIONS=--require <profile>/node_modules/dsh-pdr-plugin/src/probe/preload.cjs` and forwards
argv to `dsh` unchanged.

The preload must point at **the copy installed in the target profile**, not at the package the
launcher happens to live in. Two copies means two probe instances, each wrapping `fs` again, with
`__orig` pointing at a wrapper — the bookkeeping then amplifies itself (measured: 270 000 events /
37 MB from a 40-second window). `probe-core.cjs` also guards the same mistake with a
`Symbol.for` global singleton.

## Attribution

Three tiers, cheapest first:

1. **ALS fast path.** The loader's `RegistryService.prototype.plugin` is wrapped so the plugin
   factory runs inside an `AsyncLocalStorage` context. Any I/O it starts — directly or through an
   injected service — carries the plugin identity, because the context propagates through the
   async graph. This is the default (`als`).
2. **Stack walk.** Read the caller's file name from the stack, normalise `file://` URLs and map
   directories to plugin names. Slower, but it works when the ALS context is missing
   (the loader did not go through the wrapped path). Selected with `PDR_PROBE_MODE=stack`.
3. **`host`.** Neither tier resolved a plugin. Everything the host itself does lands here, and
   `host` is deliberately excluded from red-line evaluation and from `judge.observe()`.

Measured per-call on a fixed 1 639-op replay of real session I/O: `als` adds **2.9 µs/op**,
`stack` **114 µs/op**, `both` **114 µs/op**. Scaled to a real session (~5 600 hooks, ~34 s wall
clock): `als` ≈ **0.05 %** of the session, `stack` ≈ **1.9 %**, `both` ≈ **1.9 %**. An end-to-end
A/B of whole headless sessions measures +0.21 % with the probe installed — noise-dominated, but
it rules out any order-of-magnitude regression. That is why `als` is the default and `stack` is a
diagnostic mode — and why the earlier default of `both` was a defect, not a preference.

### Hooking before any plugin exists

`cordis.patch.yml` runs `earlyInstall` while the config is being materialised. That is early
enough to beat every plugin module import, but not early enough to beat the host's own ESM
facades. The preload closes that gap, and it also wraps `RegistryService` immediately by
reverse-`require`ing cordis from the host's `argv[1]` (Node's `require(esm)` and `import` share
the same instance), so the wrap is in place **before the first plugin is instantiated**.

Three defects this fixed, all found on real hardware:

- the hook was attached too late and 69 plugins had already registered;
- patching through `Function.prototype.apply` produced false matches, misattributing dozens of
  class-based plugins to `semver`;
- `fn.name` is read-only, so assigning to it silently failed and 31 function-style plugins were
  never wrapped at all.

After the fix, `registry.entries()` reports 132 entries and the probe reports 132 hooked.
`dsh-rewind-plugin` attributes 134 events, `headless-runner` 310, and the ESM plugin `diag` — which
was previously invisible — attributes its 7.

## Hook coverage (measured)

The matrix is now a **machine-checked test** (`test/hook-matrix-eval.mjs`), not prose: each
consumption style runs in a real child process and the recorded event stream is asserted against a
declared expectation table. When coverage changes in either direction, the test fails and forces the
table to be updated.

Measured on the current build — with the preload in place, every import style is covered:

| Consumption style | fs sync | fs/promises | child_process | http | fetch |
|---|---|---|---|---|---|
| `require('node:…')` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `import x from 'node:…'` (default) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `import * as ns from 'node:…'` (namespace) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `import { fn } from 'node:…'` (named) | ✅ | ✅ | ✅ | ✅ | ✅ |
| reference captured **before** install | ❌ | ✅ | ❌ | ✅ | ✅ |

The last row is what "no preload" looks like: references snapshotted before hooks exist bypass the
property patch, and there is no binding layer for `child_process`. That is exactly why the bootstrap
adapter matters and why a late install is reported as `PARTIAL`, never as full coverage.

`fs` and `fs.promises` are covered on both layers: 15 `fs.promises` methods and 16 `fs` methods,
because real plugins call `mkdir` / `stat` / `copyFile` / `unlink` directly by name — wrapping only
four methods missed whole categories of writes.

### Honest residual gaps

- named imports of `child_process` / `http` / `net` when the facade was created before the probe
  (measured above as the "captured before install" row);
- native modules and `process.binding` used directly;
- deliberate anti-instrumentation.

Countering a determined adversary is a separate layer of work. This plugin's goal is
**continuous, attributable visibility** — not a hostile-code sandbox.

## Bootstrap adapters (v0.3)

Injection is a property of the **launch entry**, not of the probe. `src/bootstrap/adapters.js`
name-maps every entry we know about, with the evidence rule and the limitation stated up front:

| Adapter | Supported | How the probe gets in |
|---|---|---|
| `launcher` | yes | `dsh-pdr` sets `NODE_OPTIONS=--require …/preload.cjs` and `PDR_BOOTSTRAP=launcher` |
| `preload` | yes | a caller injects `--require` itself (build scripts, CI, wrappers) |
| `desktop` | degraded | the process runs in the Desktop runtime; whether `--require` is possible depends on how it was started |
| `bundle` | degraded | `cordis.patch.yml` `earlyInstall` only — no preload window |
| `none` | no | nothing detected; the session is not monitored |

Each verdict carries `evidence` (e.g. `env:PDR_BOOTSTRAP=launcher`), so a classification can always
be traced back to a fact rather than a guess. `dsh-pdr --pdr-check` prints the same matrix offline.

The bundle adapter keeps working because the entry now exports `Config`; a loader row with a
`config:` block against a plugin without a schema fails activation silently — the failure mode that
made the panel tab disappear in v0.2.4.

## Probe health: why FULL / PARTIAL / OFFLINE

`src/bootstrap/detect.js` derives the state from counters the probe actually maintains:

- **OFFLINE** — `installed !== true`. Nothing was recorded; no runtime guarantee is offered.
- **PARTIAL** — installed, but at least one *error-severity* check failed.
- **FULL** — installed and every error-severity check passed.

| Check | Severity | Evidence it reads |
|---|---|---|
| `probe-installed` | error | `state.installed` |
| `preload-ran` | error | `markPreload()` called from `preload.cjs` |
| `registry-hooked` | error | `RegistryService.plugin` wrapped |
| `hook-order` | error | index of the first `plugin()` seen by the hook |
| `coverage-complete` | error | categories with zero wrapped APIs |
| `no-double-wrap` | error | second-layer wrap attempts rejected |
| `storage-writable` | error | `access(W_OK)` on the event directory |
| `no-store-errors` | error | JSONL append failures (multi-process contention) |
| `no-probe-errors` | error | internal error counter, with **per-site tallies** |
| `attribution-effective` | error | 20+ events, plugins registered, yet none attributed by name |
| `adapter-supported` | error | adapter marked `degraded` or `false` |
| `no-dropped-events` | **info** | bounded ring buffer rolled old events (disk keeps all) |

Dropped events are deliberately *info*: the buffer is bounded on purpose and the JSONL store keeps
everything, so counting it as degradation would make FULL unreachable in any long session — and an
unreachable "full" is worse than no state at all.

Every error site is labelled (`registry-wrap`, `record-hook`, `binding-read`, …) and surfaced as
`errorSites` in the diagnostic object. A bare `errors: 98` is not actionable; "98 × `registry-wrap`"
is what led to the v0.3 wrapping bug described below.

## Attribution is ALS-first, and the seam must not mutate plugins

The registry hook wraps `RegistryService.plugin` so every plugin's `apply` runs inside an ALS scope
carrying its name. Two implementation traps, both found on a real host:

1. **Function plugins** — assigning `fn.name` throws in strict mode (`name` is non-writable); use
   `Object.defineProperty`.
2. **Object plugins** — `Object.create(plugin)` followed by `wrapped.inject = …` throws when the
   inherited property is a read-only accessor (ESM namespace objects, frozen plugin objects). The
   throw was swallowed, so wrapping failed for *every* object plugin: 98 recorded errors, 3 127
   events with 3 121 attributed to `host` — attribution silently off.

   The fix is a shallow clone: read the plugin, write only to the clone (`safeDefine` per key), and
   keep "already wrapped" in a `WeakSet` instead of mutating the plugin. Re-registration reuses the
   cached wrapper so a reload does not fall back to the unwrapped object.

Measured after the fix on the same profile: **14 named plugins attributed**, `errors: 0`.


## One logical call, one event

A single outbound request can cross several layers (`http.request` → `net.createConnection`,
`fetch` → `net`/`tls`). Emitting per layer inflates counts and makes the UI lie. A parent-call
counter de-duplicates within the logical call, and `https` reaches `tls.connect`, so wrapping only
`net` would have missed that entire path.

Target normalisation is part of correctness, not display: `String(opts)` yields
`[object Object]`, `hostOf()` then extracts nothing, and destination checks silently stop working
for the whole `net` path. `net.connect` accepts an object, positional arguments, or a named pipe,
with the host in a different position in each; reading only `args[0]` records a remote host as
`localhost`.

## Fault isolation

Every extension point is fail-safe by contract. A failing subscriber cannot break observation
(`emit()` swallows and continues), storage failure cannot break observation, probe failure cannot
break the host, and the host-web mount falls back to the standalone preview server when `dsh-h3`
is unavailable. Block mode is the one exception, and it is explicit: it raises a controlled
`FirewallBlockError` (`code: DSH_PDR_BLOCKED`) into the plugin that violated the policy, never a
host crash.

## Host web integration

`src/host-web.js` implements the contract observed on a live community plugin
(`dsh-tauri-pet`):

```js
const server = defineWebServer((app) => {
  app.get('/path', defineEventHandler(async (event) => …));
});
apply(ctx) { ctx.effect(() => server(ctx), 'name'); }
```

`dsh-h3` and `h3` are Typert virtual modules in the host — they have no on-disk representation and
cannot be resolved offline, so the adapter accepts an injected runtime for testing
(`test/host-web-smoke.mjs`, 11 assertions), tries the real import on the production path, and
falls back to `serve.js` when it is absent. The standalone server and the host mount share one
route table (`src/client/api-handlers.mjs`), so preview behaviour equals in-host behaviour.

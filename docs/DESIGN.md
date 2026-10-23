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

| Consumption style | Layer 1 (property patch) | + Layer 2 (binding patch) |
|---|---|---|
| `require('node:…')` | ✅ | ✅ |
| `import cp from 'node:…'` (default property lookup) | ✅ | ✅ |
| `import * as ns from 'node:…'` | ✅ early / ❌ late | ✅ (fs) |
| `import { fn } from 'node:…'` (named) | ✅ early / ❌ late | ✅ (fs) |
| `globalThis.fetch` / `window.fetch` | ✅ (global lookup, no facade) | — |

`fs` and `fs.promises` are covered on both layers: 15 `fs.promises` methods and 16 `fs` methods,
because real plugins call `mkdir` / `stat` / `copyFile` / `unlink` directly by name — wrapping only
four methods missed whole categories of writes.

### Honest residual gaps

- named imports of `child_process` / `http` / `net` when the facade was created before the probe;
- native modules and `process.binding` used directly;
- deliberate anti-instrumentation.

Countering a determined adversary is a separate layer of work. This plugin's goal is
**continuous, attributable visibility** — not a hostile-code sandbox.

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

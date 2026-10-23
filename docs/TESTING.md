# Testing

All 22 test files live in `test/` and are driven by a single runner.

```bash
npm test              # run everything (CI entry point)
npm run test:list     # print which files would run
node test/run-all.mjs --only=smoke,guard-eval   # run a subset
node test/smoke.mjs   # or run one file directly
```

## PASS / SKIP / FAIL

The runner separates three outcomes on purpose:

| Outcome | Meaning | Exit code |
|---|---|---|
| `PASS` | assertions held | 0 |
| `SKIP` | the case needs a real environment that is absent (a real plugin, a profile, an external baseline); the file prints `SKIP: <reason>` plus how to restore it | 0 |
| `FAIL` | an assertion failed | 1 |

Skipping is **explicit** — a skipped case never claims to have passed. Any steady-state
`SKIP` on a case that does not actually need an environment is itself flagged in the output.

Why this matters: an earlier revision had 24 test files of which only 4 ever set a non-zero
exit code; `smoke.mjs` printed `ok:false` while the runner still showed PASS. A green CI run
that cannot go red is not a signal.

## What each suite covers

### Core behaviour

| File | Covers |
|---|---|
| `smoke.mjs` | real cordis + `cordis-plugin-loader`: firewall then victim, red-line attribution (credentials / network / subprocess / delayed timer), JSONL persistence, self-observation exclusion, health-card BLOCK, snapshot round-trip |
| `regression.mjs` | static health-card scan across the plugins installed in `$DSH_HOME`, read-only, informational |
| `real-boot.mjs` | firewall running alongside real plugins while the loader boots: attribution + a census of how those plugins consume `node:fs` |
| `real-drive.mjs` | drives real plugin code and asserts snapshot-store attribution |
| `real-block-session.mjs` | Block mode on a real loader: a sensitive read and a credential-exfil call are stopped before the I/O happens |
| `bind-attrib-diag.mjs` | attribution through the binding-layer patch |

### Fault domains

| File | Covers |
|---|---|
| `judge-eval.mjs` | 6 scenarios: zero false positives on a plugin's day job, every out-of-scope case detected |
| `guard-eval.mjs` | 8 scenarios: four block categories, zero false blocks, fail-safe |
| `update-eval.mjs` | 12 scenarios: update diff plus the isolated trial-install gate |
| `contract-infer-eval.mjs` | 16 assertions: inferred contracts are self-consistent **and** never launder an observed red line |
| `dedup-eval.mjs` | 21 assertions: one logical call → one event (fetch / http / net / https / tls / spawn), target normalisation across three `net.connect` call shapes |
| `runas-hook-eval.mjs` | 9 assertions: plugin-entry `runAs` (sync + async attribution, fail-safe, no double wrapping, class safety, the "not hooked → host" control group, function plugins with read-only `name`, `Function.prototype.apply` false hits, ESM source fingerprinting) |

### Reports, alerts, compliance

| File | Covers |
|---|---|
| `m3-report-eval.mjs` | audit report + compatibility evidence |
| `m3-compliance-eval.mjs` | 13 assertions: SARIF structure, RFC 4180 CSV, no compliance verdicts are emitted, rotated files, bad lines, dedup, source traceability |
| `alert-push-eval.mjs` | 9 assertions: off by default, rule filtering, dedup, rate limiting, fail-safe, a silence-group control that proves no self-excitation, three payload formats, content minimisation |
| `host-web-smoke.mjs` | 11 assertions: the `dsh-h3` adapter contract, verified with an injected runtime |

### Performance and baselines

| File | Covers |
|---|---|
| `m0-overhead-correct.mjs` | per-op increment × real hook count / session wall clock |
| `m0-overhead-fixed.mjs` | three-mode comparison (`none` / `als` / `stack` / `both`), for locating the cost |
| `m0-e2e-ab.mjs` | whole-machine A/B corroboration (noisy by nature; not used for the 2 % verdict) |
| `m1-checklist-eval.mjs` | checks on a real machine that `!!js` in `earlyInstall` really evaluates, and when |
| `m1-real-recall.mjs` | 3 843 labelled rows → real plugin sources vs. health cards |
| `m2-falsepositive-eval.mjs` | false-positive rate in Block mode over real benign code |

## Environment variables

All of these exist only to point a test at a real environment.

| Variable | Purpose |
|---|---|
| `DSH_DEPS` | `node_modules` of the DSH runtime; auto-detected when unset |
| `DSH_HOME` | DSH data directory, default `~/.dsh` |
| `PDR_PROBE_MODE` | attribution mode `als` (default) / `stack` / `both`, for diagnosis |
| `PDR_REAL_PLUGIN` / `PDR_REAL_PLUGIN_DIR` | which real plugin to use for the attribution regression |
| `PDR_E2E_PROFILE` / `PDR_E2E_PATCH` | profile and patch for the whole-machine A/B; the case is skipped when unset |
| `M1_ECOSYSTEM_DIR` | real-ecosystem baseline data; the recall case is skipped when unset |

## Notes for contributors

- Tests run **serially**. They hook `fs` / `net` in-process and write to temp directories; the
  probe is a process singleton, so parallel runs contaminate each other.
- Each file is spawned as its own process with `NODE_OPTIONS` cleared, so an outer preload
  cannot leak into a child.
- `test/_deps.mjs` and `test/_report.mjs` are helpers; the `_` prefix keeps them out of the run.

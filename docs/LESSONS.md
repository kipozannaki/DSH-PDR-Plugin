# Lessons from validation

Findings that changed the implementation. Each one was reproduced on real hardware before it was
fixed; they are recorded because a naive re-design will hit all of them again.

## Measurement

- **A defective evaluation set masquerades as a defective detector.** The ground-truth templates
  carried a `child_process` import and a credential constant, so even an empty plugin was flagged
  red-line (static false positives 10/10). Generating templates on demand drove that to zero.
- **Self-built ground truth does not measure real capability.** The first label set scored 100 %
  recall, which only proved the rules were self-consistent. On 154 real ecosystem plugins the same
  scanner reaches **66.1 % static recall / 17.2 % false positives**. The published threshold is now
  "static ≥ 65 %, runtime makes up the difference" rather than the fictitious ≥ 90 %.
- **Capability co-presence is not malice.** An IM/QQ bridge combining credentials with networking
  is doing its job. BLOCK is reserved for evidence of a leak path (credentials plus a real remote
  cleartext endpoint, or a hard-coded secret); capability co-presence is downgraded to a WARN that
  asks for human review.
- **Four classes of static false positive** were found and fixed: namespace URLs, `import()`
  noise, identifiers sharing a secret-like prefix, and API paths that look like secret
  assignments. The scanning rules prefer false negatives over false positives — a false positive
  costs trust.

## Probe

- **One logical call must produce one event.** Copying the event per red line made a single
  `fetch` produce two; the same call also crossed layers (`http.request` → `net.createConnection`,
  `fetch` → `net`/`tls`). Both are now handled by in-call de-duplication.
- **Self-exclusion must be path-based**, not name-based, otherwise loader discovery overwrites the
  self-registered name and JSONL writes trigger `record` again — a feedback loop that produced
  23 000 noise events.
- **Path-based is not sufficient either.** `appendFileSync` internally calls the hooked
  `writeFileSync`, so early persistence (when `DSH_HOME` exists) formed
  `record → onEvent → write → record`: 270 000 events / 37 MB in 40 seconds, which hung the check.
  Event delivery now has a re-entrancy guard and persistence uses the original `fs`.
- **"Own code" means `src/`**, not the whole package root — the plugin samples under `test/` must
  still be attributed normally.
- **The preload and the bundle may be different files.** `file:` and pnpm copy the plugin into the
  profile; preloading "this package's copy" yields two probes in one process (§ *Timing* in
  [DESIGN.md](./DESIGN.md)).
- **An unbounded event list is a self-inflicted DoS.** Ring buffer plus windowed rules, always.
- **A plugin calling `process.binding` can abort the host with a V8 assertion** (observed). That is
  what the anti-instrumentation layer exists for.

## Judgement

- **Host behaviour must be consistent across layers.** `judge.observe()` skips `host`, so the red
  line rules must skip it too — otherwise "host reads its own credential store, then calls the LLM
  API" fires `credentials+network` every single session and buries the real signal.
- **Cleartext rules need the same scope on both sides.** Loopback and reserved addresses do not
  trigger `cleartext-http`; DSH itself is on 127.0.0.1.
- **Static recall has an inherent ceiling.** Credentials injected at runtime are not visible in the
  source; that gap is what the runtime layer is for.

## Packaging

- **`file:` dependencies are copied, not linked.** Changing code or bumping the version does not
  reach the profile, and `dsh plugin add` answers "Already up to date". Remove then add.
  (Measured: source 0.2.0, profile still 0.1.1 until remove + add.)
- **Alerts must be silent by default and silent in effect.** The push path uses the hooked `fetch`,
  so it runs under `probe.silent()`; otherwise it records itself, and an `http://` webhook target
  would trigger `cleartext-http` and feed itself. Verified: zero webhook-related events across a
  full session with push enabled.

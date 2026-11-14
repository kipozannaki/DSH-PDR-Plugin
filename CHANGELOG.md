# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.3.0] — Trusted runtime monitoring

### Added
- **Bootstrap adapters** (`src/bootstrap/adapters.js`): injection is modelled as a property of the
  launch entry, not of the probe. Five entries — `launcher`, `preload`, `desktop` (degraded),
  `bundle` (degraded), `none` — each with its evidence rule, limitation and verification hint.
  Every verdict carries `evidence` (e.g. `env:PDR_BOOTSTRAP=launcher`) so a classification can be
  traced to a fact. `dsh-pdr --pdr-check` prints the same matrix offline.
- **Runtime detector** (`src/bootstrap/detect.js`): node/dsh version, platform, profile, masked
  `DSH_HOME`/home, adapter + evidence, preload status, registry hook + order, hook count, coverage
  gaps, attribution counters, storage writability, per-site error tallies.
- **Probe health monitor**: `FULL` / `PARTIAL` / `OFFLINE` derived only from counters the probe
  actually maintains, with 11 error-severity checks and one info-level note (bounded ring buffer).
  Dumped as `<dataDir>/runtime.json` (masked) and served at `POST /api/dsh-pdr/health`.
- **`dsh-pdr doctor`**: offline read of the last session's verdict — state, entry, preload, host
  version, attribution, coverage gaps, reasons, notes and error sites.
- **Hook coverage matrix as a test** (`test/hook-matrix-eval.mjs`): five import styles ×
  fs / fs.promises / child_process / http / fetch, each in a real child process; the "captured
  before install" row asserts the known residual gap instead of leaving it in prose.
- Monitor tab renders the health banner: state badge, reasons, coverage chips, attribution counts,
  hook order, plus muted info notes.

### Fixed
- **Attribution was completely off for object-style plugins** (found on a live host while adding
  the health counters): the registry hook wrapped them with `Object.create(plugin)` and then
  assigned `inject`/`Config`, which throws in strict mode when the inherited property is a read-only
  accessor (ESM namespace / frozen plugin objects). The throw was swallowed, so *every* object
  plugin failed to wrap — 98 recorded errors and 3 121 of 3 127 events attributed to `host`.
  Now wrapped by shallow clone with `safeDefine` per key; "already wrapped" lives in a `WeakSet`,
  and re-registration reuses the cached wrapper. Same profile afterwards: **14 named plugins
  attributed, `errors: 0`**.
- Repeated wrapping is refused at the property, binding and `fetch` layers and counted as
  `doubleWrapped` instead of stacking a second layer.
- JSONL append failures (multi-process contention on Windows) are counted separately as
  `storeErrors` and reported as `no-store-errors`, so they no longer masquerade as probe defects.
- `cordis.patch.yml` restores the `earlyInstall` entry — it now activates because the plugin
  exports `Config`; the bundle adapter therefore works for hosts started without the launcher
  (measured: entry active, `PARTIAL`, 6 plugins still attributed, `errors: 0`).

## [Unreleased]

### Added
- **In-app monitor tab**（行为监控）: the web UI's conversation view bar gains a `行为监控` tab
  backed by this plugin's own in-host API. Host half registers two `connection.fetch` POST routes
  (`/api/dsh-pdr/overview`, `/api/dsh-pdr/events`) through the deferred-injection seam, with a
  retrying mount because this plugin's fiber may activate before the connection service; client
  half is a dependency-free `lib/client.js` bundle (loaded via the `dsh.client` declaration,
  rendered with the host-provided React) registering the `conversation.view` slot at order 30.
  The entry now exports `Config`/`name`/`inject` — required since a loader row carrying `config:`
  against a plugin without a Config schema fails activation (found on a live host: the entry
  silently never mounted).

### Changed
- README restructured into a short entry point. Measurement detail moved to `docs/`
  ([DESIGN](docs/DESIGN.md), [TESTING](docs/TESTING.md), [LESSONS](docs/LESSONS.md)); a Chinese
  README (`README.zh.md`) added.
- `package.json` `files` now ships `docs/`, `README.zh.md` and `CHANGELOG.md`.
- Added a CI workflow that runs the suite on Linux, Windows and macOS against Node 22 and 24.
- Overhead figures restated on a per-session basis after re-measurement: per-op on a fixed
  1 639-op replay is `als` 2.9 µs / `stack` 114 µs / `both` 114 µs; scaled to a real session
  (~5 600 hooks, ~34 s) that is ≈ 0.05 % vs ≈ 1.9 % of wall clock. The earlier "16 %" figure had
  divided by a hook count accumulated over several sessions.

## [0.2.1]

### Fixed
- The isolated trial install contained a hard-coded author path, leaking a machine-specific
  location into shipped code.
- Machine-specific paths removed across the repository.
- Every test suite now sets a non-zero exit code when an assertion fails. Some suites previously
  printed `ok:false` while the runner still reported PASS.

### Added
- `assets/` ships with the package so the README screenshot resolves on npm.

## Earlier milestones

Work before 0.2.1 was developed milestone by milestone (M0 probe and overhead closure, M1 real
host validation and recall baseline, M2 judge/guard/update, M3 enterprise features). The findings
that changed the implementation are recorded in [docs/LESSONS.md](docs/LESSONS.md); the design
rationale is in [docs/DESIGN.md](docs/DESIGN.md).

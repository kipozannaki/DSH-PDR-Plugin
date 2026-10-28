# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

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

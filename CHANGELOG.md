# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

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

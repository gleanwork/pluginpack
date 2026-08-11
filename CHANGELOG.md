# Changelog

## v0.11.1 (2026-08-11)

#### :bug: Bug Fix

- [#32](https://github.com/gleanwork/pluginpack/pull/32) Fix validation of shared source repositories ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#33](https://github.com/gleanwork/pluginpack/pull/33) Derive accepted PR labels from the repository ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## v0.11.0 (2026-08-10)

#### :boom: Breaking Change

- [#30](https://github.com/gleanwork/pluginpack/pull/30) feat: add shared plugin sources and target overlays ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#26](https://github.com/gleanwork/pluginpack/pull/26) fix: fail the build on unresolvable partial references ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :rocket: Enhancement

- [#30](https://github.com/gleanwork/pluginpack/pull/30) feat: add shared plugin sources and target overlays ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix

- [#28](https://github.com/gleanwork/pluginpack/pull/28) fix: stop the delete guard breaking the documented layout, and follow symlinks when checking containment ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#26](https://github.com/gleanwork/pluginpack/pull/26) fix: fail the build on unresolvable partial references ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#22](https://github.com/gleanwork/pluginpack/pull/22) fix: close 1.0-readiness gaps (delete-guard, cross-target collisions, validation, docs) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#31](https://github.com/gleanwork/pluginpack/pull/31) fix(ci): set up toolchain with mise ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#29](https://github.com/gleanwork/pluginpack/pull/29) refactor: address code-review findings on the containment fixes ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#27](https://github.com/gleanwork/pluginpack/pull/27) test: cover the destructive paths, and fix two gaps they exposed ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## v0.10.0 (2026-07-29)

#### :rocket: Enhancement

- [#21](https://github.com/gleanwork/pluginpack/pull/21) feat: add partials for shared, inlined text fragments across skills ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## v0.9.0 (2026-07-27)

#### :rocket: Enhancement

- [#11](https://github.com/gleanwork/pluginpack/pull/11) feat: per-target MCP config overrides + plugin-root files ([@eshwar-sundar-glean](https://github.com/eshwar-sundar-glean))

#### Committers: 1

- Eshwar Sundar ([@eshwar-sundar-glean](https://github.com/eshwar-sundar-glean))



## v0.8.0 (2026-07-27)

#### :rocket: Enhancement

- [#18](https://github.com/gleanwork/pluginpack/pull/18) feat: add install-info command and buildInstallSnippet API ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#12](https://github.com/gleanwork/pluginpack/pull/12) feat: add opt-in update-check hook for claude and cursor targets ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix

- [#20](https://github.com/gleanwork/pluginpack/pull/20) fix(deps): resolve brace-expansion DoS advisory; scope audit to production deps ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#16](https://github.com/gleanwork/pluginpack/pull/16) fix: correct Codex plugin output for the target registry ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#13](https://github.com/gleanwork/pluginpack/pull/13) fix: correct Copilot and Antigravity plugin output + polymorphic target registry ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#17](https://github.com/gleanwork/pluginpack/pull/17) refactor: delete legacy per-target emitters/validators now that all targets are migrated ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#19](https://github.com/gleanwork/pluginpack/pull/19) refactor: migrate claude to the target registry (no behavior change) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#14](https://github.com/gleanwork/pluginpack/pull/14) refactor: migrate cursor to the target registry ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## 0.7.0 (2026-07-13)

- Add a native Codex target that emits `.agents/plugins/marketplace.json`,
  `.codex-plugin/plugin.json`, skills, hooks, assets, and optional MCP config.
- Add per-plugin marketplace entry overrides for Codex policy and category
  metadata.
- Consolidate target dispatch behind an adapter registry and harden source,
  path, cleanup, and dependency handling.

## 0.1.0

- Initial prerelease.

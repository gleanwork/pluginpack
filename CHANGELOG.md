# Changelog

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

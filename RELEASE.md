# Release process

A maintainer runs releases with
[release-it](https://github.com/release-it/release-it/) and
[lerna-changelog](https://github.com/lerna/lerna-changelog/).

## Preparation

Review every PR merged since the last release. Give each PR that needs release
notes a rendered `lerna-changelog` label and a title that describes the change
for users. Changelogs are for people; see
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

The rendered labels are:

- `breaking`: an incompatible change to the public contract described below.
- `enhancement`: a new feature or enhancement.
- `bug`: a fix for a bug in a previous release.
- `documentation`: a documentation change.
- `internal`: an internal change that needs release notes.

Check the generated changelog for omitted PRs, especially bot PRs and PRs with
only labels outside these five categories. The label check does not guarantee
that a change appears in the changelog or has the right category.

## Release

1. Check out `main` and pull the reviewed commits. release-it requires `main`.
2. Install the locked dependencies with `npm ci`.
3. Run `npm run check` and `npm run audit`.
4. Set `GITHUB_AUTH` to a [GitHub personal access token][generate-token] with
   the `repo` scope. Both lerna-changelog and release-it use this variable.
5. Choose the version increment explicitly. For the 0.12.0 release from 0.11.1:

   ```sh
   npm run release -- minor
   ```

6. Review the proposed version and generated changelog in the prompts. Stop if
   either is wrong. release-it then creates the release commit and tag, pushes
   them, publishes to npm, and creates the GitHub Release.

Use `npm run release -- minor` for breaking 0.x releases, not an inferred bump
from a PR label. A `breaking` label controls the changelog category; it does
not choose the release increment. Use `npm run release -- patch` for a patch,
or `npm run release -- major` for a major version.

[generate-token]: https://github.com/settings/tokens/new?scopes=repo&description=GITHUB_AUTH+env+variable

## What counts as a breaking change

The public contract includes the TypeScript API (`src/index.ts`), CLI flags,
config, and the files written into a consumer's repository. An incompatible
change includes a new default directory, a renamed manifest field, a change to
JSON field order, or a different `.pluginpack/<target>.json` shape. Output can
break a consumer's committed repository even when no API signature changes.
Label these PRs `breaking` and provide migration notes. During 0.x, breaking
changes require a minor release; starting with 1.0, they require a major release.

### Correctness fixes

Correctness fixes can ship in a patch release even when output changes, but only
when the old behavior violated the documented contract for the selected target
and format. Examples include preserving source bytes instead of corrupting them,
preventing data loss, and fixing output that the documented host format rejects.
Include a regression test that proves the violation. Label the PR `bug` and
explain the old and corrected behavior in release notes. Call out any action a
consumer must take to rebuild or recover files.

This exception does not cover a new upstream format, a new default, or removing
previously valid config. Those changes follow the compatibility policy below
and need migration notes. A correctness fix is not a reason to silently replace
one supported host format with another.

## Output compatibility

For a fixed target and `format`, 1.x preserves the documented output contract
for existing valid config, including paths, manifest fields and field order.
New optional config may add output when a user opts in. The correctness-fix
exception above still applies.

An upstream host format change ships as a new opt-in `format` value in a minor release.
The default changes only in a major release. Keep the existing format available
through the current major series. A host dropping support for that format does
not permit pluginpack to change it silently; document the affected host versions
and the opt-in migration. Starting with 1.0, removing a supported format also
requires a major release. The pre-1.0 `codex.format: "legacy"` migration follows
the breaking-minor rule: deprecated in 0.12 and removed in 0.13.

### Verified against host versions

These are the verification limits recorded in each target's citations in
`src/targets/<target>.ts`, not a promise of compatibility with every past or
future client release. Where a client version was not recorded, the dated docs
snapshot is the available evidence. It is not a tested version range. Agent
Plugins 1.0.0 is a format version, not a Codex or Copilot client version.

| Target          | Verified version or evidence                                                                                                                                                                   | Source                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`        | Claude Code client version was not recorded; manifest validation checked 2026-07-26, install commands 2026-07-25.                                                                              | [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)                                                                                                                                                                 |
| `cursor`        | Cursor client version was not recorded; plugin and marketplace docs checked 2026-07-26. Vendored Glean schemas are pinned at `424c3485`, rechecked against `6f3ad6e6` on 2026-07-28.           | [Cursor plugin reference](https://cursor.com/docs/reference/plugins.md), [schema provenance](tests/fixtures/cursor/SOURCE.md)                                                                                                                |
| `copilot`       | Copilot CLI client version was not recorded; native plugin docs checked 2026-07-25 and published manifest placement 2026-07-26.                                                                | [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [published plugin](https://github.com/github/copilot-advanced-security-plugin/blob/main/.github/plugin/plugin.json) |
| `antigravity`   | Antigravity client version was not recorded; CLI layout and IDE hooks docs checked 2026-07-25.                                                                                                 | [CLI plugins](https://antigravity.google/docs/cli/plugins), [IDE plugins](https://antigravity.google/docs/ide/plugins)                                                                                                                       |
| `codex`         | Agent Plugins 1.0.0 package format; Codex client version was not recorded. Packaging and marketplace docs checked 2026-10-02; legacy manifest checked 2026-07-26, install commands 2026-07-25. | [Codex packaging](https://developers.openai.com/codex/plugins/build), [install commands](https://learn.chatgpt.com/codex/developer-commands), [schema provenance](tests/fixtures/agent-plugins/SOURCE.md)                                    |
| `agent-plugins` | Agent Plugins 1.0.0, checked 2026-10-02. Client profiles do not imply a tested client version range.                                                                                           | [Agent Plugins specification](https://agent-plugins.org/specification), [schema provenance](tests/fixtures/agent-plugins/SOURCE.md)                                                                                                          |

Recheck the relevant citations and conformance tests when changing a target's
output. Record the exact client version when running a host CLI, or the spec
version and docs verification date when no versioned host oracle exists.
Update this list in the same PR. See [CONFORMANCE.md](CONFORMANCE.md) for the
strength and limits of each target's checks. Package-client citations also live
in `src/package-clients.ts`.

## PR label check and branch protection

`main` requires the checks `test (22.12.0)`, `test (24)`, and `labels`.
Admins can bypass these requirements. No approving review is required.
The two test checks run `.github/workflows/ci.yml`; the `labels` check runs
`.github/workflows/pr-label.yml`. Maintainers remain responsible for reviewing
changes and the changelog, including any use of the admin bypass.

The label check accepts any label in the repository's current, paginated label
catalog, as decided in [PR #33](https://github.com/gleanwork/pluginpack/pull/33).
It does not require one of lerna-changelog's five rendered labels. For example,
a PR labeled only `question` passes if that label exists in the repository,
but it will not appear in the changelog. The check warns about this case; the
maintainer must add a rendered label if the change needs release notes.
Bot authors are exempt: their `labels` job reports success without checking
labels. A passing label check cannot judge whether a diff is breaking.

## Accepted risk: dev-only audit findings

`npm audit` without `--omit=dev` reports vulnerabilities in development tools,
including lerna-changelog's dependency chain. `npm run audit` (what CI runs)
is scoped to production dependencies and reports clean. Development
dependencies do not ship in the published package. Do not add overrides for
dev-only findings; revisit this risk if release tooling processes untrusted
input, or replace it when a maintained alternative is available.

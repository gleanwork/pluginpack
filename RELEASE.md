# Release Process

Releases are mostly automated using
[release-it](https://github.com/release-it/release-it/) and
[lerna-changelog](https://github.com/lerna/lerna-changelog/).

## Preparation

Since the majority of the actual release process is automated, the primary
remaining task prior to releasing is confirming that all pull requests that
have been merged since the last release have been labeled with the appropriate
`lerna-changelog` labels and the titles have been updated to ensure they
represent something that would make sense to our users. Some great information
on why this is important can be found at
[keepachangelog.com](https://keepachangelog.com/en/1.0.0/), but the overall
guiding principle here is that changelogs are for humans, not machines.

When reviewing merged PR's the labels to be used are:

- breaking - Used when the PR is considered a breaking change.
- enhancement - Used when the PR adds a new feature or enhancement.
- bug - Used when the PR fixes a bug included in a previous release.
- documentation - Used when the PR adds or updates documentation.
- internal - Used for internal changes that still require a mention in the
  changelog/release notes.

## Release

Once the prep work is completed, the actual release is straight forward:

- First, ensure that you have installed your projects dependencies:

```sh
npm install
```

- Second, ensure that you have obtained a
  [GitHub personal access token][generate-token] with the `repo` scope (no
  other permissions are needed). Make sure the token is available as the
  `GITHUB_AUTH` environment variable.

  For instance:

  ```bash
  export GITHUB_AUTH=abc123def456
  ```

[generate-token]: https://github.com/settings/tokens/new?scopes=repo&description=GITHUB_AUTH+env+variable

- And last (but not least 😁) do your release.

```sh
npx release-it
```

[release-it](https://github.com/release-it/release-it/) manages the actual
release process. It will prompt you to to choose the version number after which
you will have the chance to hand tweak the changelog to be used (for the
`CHANGELOG.md` and GitHub release), then `release-it` continues on to tagging,
pushing the tag and commits, etc.

## What counts as a breaking change

pluginpack's public contract isn't just its TypeScript API (`src/index.ts`)
and CLI flags — it's also the _shape of the files it writes into a consumer's
repo_ (managed-file layout, manifest field names, default directory
conventions). A change that alters generated output for an existing config
with no code-level signature change (e.g. a different default `outDir`
convention, a renamed manifest field, a different `.pluginpack/<target>.json`
shape) is breaking for the same reason a database migration is breaking: it
can affect a consumer's already-generated, already-committed repo on their
next build, even though nothing in `import { ... } from "@gleanwork/pluginpack"`
changed. Label PRs with `breaking` under that broader definition, not just for
API/CLI signature changes.

## PR label enforcement

CI (`.github/workflows/ci.yml`, `labels` job) requires every PR to carry one
of the five labels above before merge — this catches an unlabeled PR, but it
cannot judge whether the label chosen is the _correct_ one. Whether a given
diff is actually breaking under the definition above is still a human call at
review time.

## Accepted risk: dev-only audit findings

`npm audit` (unscoped) reports vulnerabilities in `@release-it-plugins/lerna-changelog`'s
dependency chain (`lerna-changelog` → `make-fetch-happen` → `cacache`/`tar`),
with no upstream fix available. `npm run audit` (what CI runs) is scoped to
`--omit=dev` and reports clean, per `CLAUDE.md`'s documented rationale:
devDependencies never ship in the published package. This is a tracked,
accepted gap, not an oversight — revisit if `lerna-changelog` is ever run
against untrusted input, or replace it if a maintained alternative appears.

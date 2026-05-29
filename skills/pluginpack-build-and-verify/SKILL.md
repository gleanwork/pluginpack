---
name: pluginpack-build-and-verify
description: Use when working in a repo that uses pluginpack (it has a pluginpack.config.ts) and you need to build the native plugin outputs, validate them, prune stale files, or check whether a generated plugin repo has drifted — i.e. driving the pluginpack CLI and interpreting its exit codes.
---

# Building and verifying with pluginpack

pluginpack is a deterministic build tool. Every command is scriptable and
exits non-zero on failure.

## Build

```bash
pluginpack build                      # all configured targets
pluginpack build --target cursor      # one target
pluginpack build --target claude --dry-run   # print planned managed files, write nothing
```

Exit 0 on success; 1 on config/source/output failure. The build errors if two
targets resolve to the same output path (give them distinct `outDir`s).

## Validate

```bash
pluginpack validate --target cursor --dir ../cursor-plugins
```

Checks an output directory against that target's native manifest/path/frontmatter
rules. Exit 0 = passes, 1 = errors. (For Claude, `claude plugin validate` is the
authoritative check; pluginpack's conformance tests use it when available.)

## Diff (CI staleness gate)

```bash
pluginpack diff --target cursor --against ../cursor-plugins
```

Builds to a temp dir and compares managed files against an existing target repo.
Exit 1 when the repo is stale — wire this into CI to fail or to open a PR against
the generated repo. Use `ignoredDiffPaths` in the target config for paths the
generated repo intentionally owns.

## Prune / clean

```bash
pluginpack prune --dry-run    # show stale managed files
pluginpack prune              # remove them
pluginpack clean --target cursor   # remove all managed files for a target
```

These only touch files recorded in `.pluginpack/<target>.json`. A guard refuses
to delete anything inside your declared source (`source.skills`/`source.plugins`)
or the config; pass `--force` to override (rarely needed — usually it means an
`outDir` overlaps your source).

## Developing pluginpack itself

Run the full gate before considering work done: `npm run check`
(format, lint, typecheck, test, build, docs). Regenerate the README CLI
reference with `node dist/cli.js docs` after changing commands.

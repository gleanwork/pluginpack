# AGENTS.md

<!-- configure-agents:review start -->

## Ask first

Agents ask a person in the current conversation before running these commands or tools in this repository. The rules live in `.claude/settings.json` (the `draft-pr` preset); edit them there and run `configure-agents review` to update this section.

- `Bash(gh pr comment *)`
- `Bash(gh pr review *)`
- `Bash(gh pr close *)`
- `Bash(gh issue create *)`
- `Bash(gh issue comment *)`
- `Bash(gh issue close *)`
- `Bash(gh release *)`
- `Bash(npm publish *)`
- `Bash(pnpm publish *)`
- `Bash(yarn npm publish *)`
- `Bash(git push -f *)`
- `Bash(git push * -f)`
- `Bash(git push * -f *)`
- `Bash(git push *--force*)`
- `Bash(git push * main)`
- `Bash(git push * master)`
- `Bash(git push *:main)`
- `Bash(git push *:master)`
- `mcp__*github*__create_*`
- `mcp__*github*__add_*`
- `mcp__*github*__update_*`
- `mcp__*github*__merge_*`
- `mcp__*github*__submit_*`
- `mcp__*github*__delete_*`
- `mcp__*github*__push_*`
- `mcp__*slack*__*post*`
- `mcp__*slack*__*send*`
- `Bash(gh pr merge *)`
- `Bash(gh pr ready *)`

## Never

Agents never run these in this repository:

- Nothing is denied outright.

## Code review

Follow [REVIEW.md](REVIEW.md) when reviewing changes in this repository.

<!-- configure-agents:review end -->

## Commit and PR guidelines

- Branch names: a short description of the change, such as `fix/prune-symlinks`. No tool prefixes.
- Commits: Conventional Commits, `type(scope): summary`.
- Merge method: squash or rebase. PRs need a changelog label; CI checks it.
- Releases: `npm run release` (`release-it` with `@release-it-plugins/lerna-changelog`). A maintainer runs it; agents do not.

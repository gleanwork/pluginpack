# REVIEW.md

Rules for reviewing changes in this repository. People and review agents both follow this file.

## Always check

- **Schemas are the source of truth.** Config types come from the zod schemas in `src/schema.ts` through `z.infer`. A config change edits the schema, not `src/types.ts`.
- **Targets come from evidence.** A new target, or a change to a target's layout or manifest, cites the host's official docs or a real plugin it was checked against. Guessed formats are a blocker.
- **The artifact is the seam.** Build, dry run, diff, prune and validate all derive from the in-memory `Artifact`. A change that writes to disk outside it, or makes one of those commands disagree with another, is a blocker.
- **Destructive paths stay guarded.** `prune` and `clean` remove only managed files. A change near them needs a test that proves unmanaged and source files survive.
- **Partials stay narrow.** Only `{{> name}}` tags are substituted, and an unresolved tag fails the build. Do not widen substitution or let it pass silently.
- **Docs follow the CLI.** A change to commands or options regenerates the README CLI reference (`node dist/cli.js docs`).
- **Support floor.** Node 22.12.0 is the supported floor (`engines`), not the Node version the dev tooling pins.

## Flag only when

- The change behaves wrongly in a scenario you can describe, emits output a host rejects, or loses an error. Name the scenario and the target.
- A conformance test would pass even if the change were reverted.
- A failure is silent, vague, or blamed on the wrong part. Errors name the file, the field, and the fix.

## Skip

- Generated files: `dist/`, `coverage/`, and the generated CLI section of the README.
- Findings in dev-only dependencies. `npm run audit` covers production dependencies on purpose.
- Formatting and lint issues that `npm run check` already handles.

## Severity

- **Blocker:** wrong output for a target, a destructive path that can touch unmanaged files, a security problem, or a breaking config change without a migration note.
- **Should fix:** changed behavior without a test, a target change without its source cited, or an unclear name in the public API.
- **Nit:** anything else. Group nits together and never block on them.

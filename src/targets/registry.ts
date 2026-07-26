import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { cursor } from "./cursor.js";
import type { TargetName } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

/**
 * Migrated targets, filled in one at a time as each moves off the legacy
 * per-target functions in `../targets.ts` and `../validate.ts` — see
 * `../adapters.ts`, which falls back to those for any target not yet
 * present here. Becomes `Record<TargetName, PluginTargetDefinition>` once
 * every target has an entry, at which point `adapters.ts` can be deleted.
 */
export const targets: Partial<Record<TargetName, PluginTargetDefinition>> = {
  copilot,
  antigravity,
  cursor,
  claude,
  codex,
};

import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { cursor } from "./cursor.js";
import type { TargetName } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

/**
 * Every target, in one place — `Record<TargetName, …>` is exhaustive at
 * compile time, so a new `TargetName` won't build until it has an entry
 * here. `../adapters.ts` builds its emit/validate dispatch, the CLI
 * `--target` choices, and the set `build()` iterates all from this.
 */
export const targets: Record<TargetName, PluginTargetDefinition> = {
  copilot,
  antigravity,
  cursor,
  claude,
  codex,
};

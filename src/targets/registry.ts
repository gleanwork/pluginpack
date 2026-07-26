import type { TargetName } from "../types.js";
import type { PluginTargetDefinition } from "./types.js";

// Filled in one target at a time as each migrates off the legacy
// emitXxx/validateXxx functions in ../targets.ts and ../validate.ts (see
// CLAUDE.md's target-registry note and the migration plan in this repo's
// history). Once every TargetName has an entry, this becomes
// `Record<TargetName, PluginTargetDefinition>` and `adapters.ts` is deleted.
export const targets: Partial<Record<TargetName, PluginTargetDefinition>> = {};

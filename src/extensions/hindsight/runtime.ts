import type { HindsightMemoryAdapter } from "../../../packages/memory-hindsight/src/index.js";

export interface HindsightRuntimeBinding {
  readonly adapter: HindsightMemoryAdapter;
  readonly projectId: string;
}

const RUNTIME_SLOT = Symbol.for("dumb-bot.hindsight.runtime-binding");
type RuntimeGlobal = Record<PropertyKey, unknown>;

/** Shares the exact CLI-registered adapter with Pi's in-process extension loader. */
export function bindHindsightRuntime(binding: HindsightRuntimeBinding): () => void {
  const global = globalThis as unknown as RuntimeGlobal;
  const previous = global[RUNTIME_SLOT];
  global[RUNTIME_SLOT] = binding;

  return () => {
    if (global[RUNTIME_SLOT] !== binding) return;
    if (previous === undefined) delete global[RUNTIME_SLOT];
    else global[RUNTIME_SLOT] = previous;
  };
}

export function getHindsightRuntimeBinding(): HindsightRuntimeBinding | undefined {
  const value = (globalThis as unknown as RuntimeGlobal)[RUNTIME_SLOT];
  if (!value || typeof value !== "object") return undefined;
  const binding = value as Partial<HindsightRuntimeBinding>;
  return binding.adapter && typeof binding.projectId === "string"
    ? binding as HindsightRuntimeBinding
    : undefined;
}

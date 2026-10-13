import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { ComponentRegistry } from "./core/registry.js";
import { DumbBotRuntime } from "./core/runtime.js";
import {
  HindsightMemoryAdapter,
  type HindsightMemoryAdapterOptions,
} from "../packages/memory-hindsight/src/index.js";
import type { HindsightMemoryAdapter as HindsightAdapter } from "../packages/memory-hindsight/src/index.js";
import { bindHindsightRuntime } from "./extensions/hindsight/runtime.js";

export interface CliHindsightOptions {
  readonly projectId: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly createAdapter?: (options: HindsightMemoryAdapterOptions) => HindsightAdapter;
  readonly onEnabled?: (message: string) => void;
  readonly onDisabled?: (message: string) => void;
}

/** Register the CLI's Hindsight extension and bind the exact adapter instance Pi will use. */
export function setupHindsightForCli(
  registry: ComponentRegistry,
  options: CliHindsightOptions,
): () => void {
  registry.registerExtension({
    id: "extension.hindsight-memory",
    path: fileURLToPath(new URL("./extensions/hindsight/extension.ts", import.meta.url)),
    capabilities: ["memory.recall", "memory.reflect", "memory.retain"],
  });

  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) {
    options.onDisabled?.("Hindsight memory is disabled: set HINDSIGHT_BASE_URL to an absolute service URL; set HINDSIGHT_API_KEY only when service authentication is enabled.");
    return () => undefined;
  }

  try {
    const apiKey = options.apiKey?.trim();
    const createAdapter = options.createAdapter ?? ((adapterOptions) => new HindsightMemoryAdapter(adapterOptions));
    const adapter = createAdapter({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    });
    registry.registerAdapter("memory", adapter);
    const unbind = bindHindsightRuntime({ adapter, projectId: options.projectId });
    options.onEnabled?.("Hindsight memory enabled: recall/reflect/retain tools registered; forget remains disabled.");
    return unbind;
  } catch (error) {
    options.onDisabled?.("Hindsight memory is disabled due to invalid configuration. Check that HINDSIGHT_BASE_URL is an absolute HTTP(S) URL without embedded credentials, and set HINDSIGHT_API_KEY only when authentication is enabled. Values are omitted from this message.");
    return () => undefined;
  }
}

export function modelConfigurationHint(model: unknown): string | undefined {
  if (model) return undefined;
  return "No model is configured yet. In Pi, run /login to authenticate a provider and /model to select a model, then restart dumb-bot. For compatible endpoints, see docs/configuration-health.md.";
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const projectId = `project_${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;
  const registry = new ComponentRegistry();
  registry.registerExtension({
    id: "extension.i-have-adhd",
    path: fileURLToPath(new URL("./extensions/adhd/extension.ts", import.meta.url)),
    capabilities: ["session.state", "context.inject", "command.register"],
  });
  const unbindHindsight = setupHindsightForCli(registry, {
    projectId,
    baseUrl: process.env.HINDSIGHT_BASE_URL,
    apiKey: process.env.HINDSIGHT_API_KEY,
    onEnabled: (message) => console.log(message),
    onDisabled: (message) => console.warn(message),
  });

  const sessionId = process.env.DUMB_BOT_SESSION_ID?.trim();
  const selection = sessionId
    ? { mode: "resume" as const, sessionId }
    : process.env.DUMB_BOT_CONTINUE === "1"
      ? { mode: "continue" as const }
      : { mode: "new" as const };
  const runtime = new DumbBotRuntime(registry);
  const managed = await runtime.start({ projectId, cwd, selection });
  console.log(`dumb-bot ready — Pi session ${managed.sessionId}`);
  if (managed.sessionFile) console.log(`session file: ${managed.sessionFile}`);
  const modelHint = modelConfigurationHint(managed.session.model);
  if (modelHint) console.log(modelHint);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const unsubscribe = managed.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "agent_settled") {
      stdout.write("\n");
    }
  });
  try {
    stdout.write("> ");
    for await (const raw of input) {
      const line = raw.trim();
      if (line === "/exit" || line === "/quit") break;
      if (!line) {
        stdout.write("> ");
        continue;
      }
      try {
        await managed.prompt(line);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      stdout.write("> ");
    }
  } finally {
    unsubscribe();
    input.close();
    runtime.stop();
    unbindHindsight();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

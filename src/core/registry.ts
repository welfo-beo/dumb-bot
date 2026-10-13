export type AdapterKind = "memory" | "provider" | "security" | "tool";

export interface CapabilityModule {
  readonly id: string;
  readonly capabilities: object;
}

export interface RegisteredAdapter<T = unknown> {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly instance: T;
}

export interface ExtensionRegistration {
  readonly id: string;
  readonly path: string;
  readonly capabilities: readonly string[];
}

function normalizeCapabilities(value: object): Readonly<Record<string, boolean>> {
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new TypeError("component must declare at least one capability");
  const normalized: Record<string, boolean> = {};
  for (const [name, enabled] of entries) {
    if (!name || typeof enabled !== "boolean") {
      throw new TypeError(`capability ${name || "<empty>"} must be a boolean`);
    }
    normalized[name] = enabled;
  }
  return Object.freeze(normalized);
}

/** Registry metadata only; Pi remains the sole runtime and session owner. */
export class ComponentRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();
  private readonly extensions = new Map<string, ExtensionRegistration>();

  registerAdapter<T extends CapabilityModule>(kind: AdapterKind, instance: T): RegisteredAdapter<T> {
    if (!instance.id?.trim()) throw new TypeError("adapter id is required");
    if (this.adapters.has(instance.id) || this.extensions.has(instance.id)) {
      throw new Error(`component id already registered: ${instance.id}`);
    }
    const entry: RegisteredAdapter<T> = Object.freeze({
      id: instance.id,
      kind,
      capabilities: normalizeCapabilities(instance.capabilities),
      instance,
    });
    this.adapters.set(entry.id, entry as RegisteredAdapter);
    return entry;
  }

  registerExtension(extension: ExtensionRegistration): ExtensionRegistration {
    if (!extension.id?.trim()) throw new TypeError("extension id is required");
    if (!extension.path?.trim()) throw new TypeError("extension path is required");
    if (this.adapters.has(extension.id) || this.extensions.has(extension.id)) {
      throw new Error(`component id already registered: ${extension.id}`);
    }
    const entry = Object.freeze({
      id: extension.id,
      path: extension.path,
      capabilities: Object.freeze([...new Set(extension.capabilities)]),
    });
    this.extensions.set(entry.id, entry);
    return entry;
  }

  getAdapter<T = unknown>(id: string): RegisteredAdapter<T> | undefined {
    return this.adapters.get(id) as RegisteredAdapter<T> | undefined;
  }

  requireAdapter<T = unknown>(id: string): RegisteredAdapter<T> {
    const entry = this.getAdapter<T>(id);
    if (!entry) throw new Error(`adapter not registered: ${id}`);
    return entry;
  }

  listAdapters(): readonly RegisteredAdapter[] {
    return [...this.adapters.values()];
  }

  listExtensions(): readonly ExtensionRegistration[] {
    return [...this.extensions.values()];
  }

  getExtensionPaths(): readonly string[] {
    return this.listExtensions().map((extension) => extension.path);
  }
}

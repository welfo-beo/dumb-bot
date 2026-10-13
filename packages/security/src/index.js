import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile as readFileFromDisk, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CAPABILITIES = Object.freeze({
  read: "workspace.read",
  write: "workspace.write",
  execute: "command.execute",
});

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const GENERIC_RESOURCES = Object.freeze({ outside: "<outside-workspace>", command: "command" });

export class SecurityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
  }
}

export class CommandTimeoutError extends SecurityError {
  constructor(timeoutMs) {
    super("COMMAND_TIMEOUT", `Command timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CommandExitError extends SecurityError {
  constructor(exitCode, signal) {
    super("COMMAND_FAILED", "Command exited unsuccessfully");
    this.name = "CommandExitError";
    this.exitCode = exitCode;
    this.signal = signal ?? undefined;
  }
}

export class OutputLimitError extends SecurityError {
  constructor() {
    super("COMMAND_OUTPUT_LIMIT", "Command output exceeded the configured limit");
    this.name = "OutputLimitError";
  }
}

/**
 * A deliberately small per-workspace policy object. Create one instance for each
 * session/workspace boundary; it does not own session state or an agent loop.
 */
export class WorkspaceSecurity {
  #root;
  #emit;
  #requestApproval;
  #defaultTimeoutMs;
  #maxOutputBytes;

  static async create({
    workspaceRoot,
    emit,
    requestApproval,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  }) {
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      throw new TypeError("workspaceRoot is required");
    }
    if (typeof emit !== "function") {
      throw new TypeError("emit must be an event sink");
    }
    if (requestApproval !== undefined && typeof requestApproval !== "function") {
      throw new TypeError("requestApproval must be a function");
    }
    validateTimeout(timeoutMs);
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new RangeError("maxOutputBytes must be a positive safe integer");
    }

    const root = await realpath(path.resolve(workspaceRoot));
    if (!(await stat(root)).isDirectory()) {
      throw new TypeError("workspaceRoot must be a directory");
    }
    return new WorkspaceSecurity({ root, emit, requestApproval, timeoutMs, maxOutputBytes });
  }

  constructor({ root, emit, requestApproval, timeoutMs, maxOutputBytes }) {
    this.#root = root;
    this.#emit = emit;
    this.#requestApproval = requestApproval;
    this.#defaultTimeoutMs = timeoutMs;
    this.#maxOutputBytes = maxOutputBytes;
  }

  /** Reads a regular file whose resolved target remains inside the workspace. */
  async readFile({ sessionId, path: requestedPath, encoding = "utf8" }) {
    requireSessionId(sessionId);
    let target;
    try {
      target = await this.#resolveExistingFile(requestedPath);
    } catch (error) {
      if (error instanceof SecurityError) {
        await this.#deny(sessionId, CAPABILITIES.read, GENERIC_RESOURCES.outside, undefined, error.code);
      }
      throw error;
    }

    const resource = this.#relativeResource(target);
    let content;
    try {
      content = await readFileFromDisk(target, encoding === "buffer" ? undefined : encoding);
    } catch (error) {
      await this.#fail(sessionId, CAPABILITIES.read, resource, error);
      throw error;
    }
    await this.#emit({
      type: "capability.executed",
      sessionId,
      capability: CAPABILITIES.read,
      resource,
      timestamp: new Date().toISOString(),
    });
    return content;
  }

  /**
   * Writes a file only after a one-operation approval. Parent directories must
   * already exist; symlink targets are rejected rather than followed.
   */
  async writeFile({ sessionId, path: requestedPath, data }) {
    requireSessionId(sessionId);
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new TypeError("data must be a string or Uint8Array");
    }

    let target;
    try {
      target = await this.#resolveWriteTarget(requestedPath);
    } catch (error) {
      if (error instanceof SecurityError) {
        await this.#deny(sessionId, CAPABILITIES.write, GENERIC_RESOURCES.outside, undefined, error.code);
      }
      throw error;
    }

    const approvalRequestId = await this.#approve({
      sessionId,
      capability: CAPABILITIES.write,
      resource: this.#relativeResource(target),
      reason: "Explicit approval is required before writing a workspace file",
      details: { operation: "write-file", path: this.#relativeResource(target) },
    });

    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      const handle = await open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
        0o600,
      );
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    } catch (error) {
      await this.#fail(sessionId, CAPABILITIES.write, this.#relativeResource(target), error, approvalRequestId);
      throw error;
    }
    await this.#emit({
      type: "capability.executed",
      sessionId,
      capability: CAPABILITIES.write,
      resource: this.#relativeResource(target),
      approvalRequestId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Executes an argv vector without a shell, after explicit approval. The
   * working directory must be inside the workspace. This is an approval/policy
   * layer, not an OS sandbox: approved programs can still access host resources.
   */
  async executeCommand({
    sessionId,
    command,
    args = [],
    cwd = ".",
    timeoutMs = this.#defaultTimeoutMs,
    signal,
  }) {
    requireSessionId(sessionId);
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      throw new TypeError("command must be a non-empty executable name");
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new TypeError("args must be an array of strings without NUL bytes");
    }
    validateTimeout(timeoutMs);
    if (signal?.aborted) throw new SecurityError("COMMAND_ABORTED", "Command was aborted");

    let workingDirectory;
    try {
      workingDirectory = await this.#resolveExistingDirectory(cwd);
    } catch (error) {
      if (error instanceof SecurityError) {
        await this.#deny(sessionId, CAPABILITIES.execute, GENERIC_RESOURCES.outside, undefined, error.code);
      }
      throw error;
    }

    const relativeCwd = this.#relativeResource(workingDirectory);
    const approvalRequestId = await this.#approve({
      sessionId,
      capability: CAPABILITIES.execute,
      resource: GENERIC_RESOURCES.command,
      reason: "Explicit approval is required before executing a command",
      // Private to the approval callback; never copied into audit events.
      details: { operation: "execute-command", command, args: [...args], cwd: relativeCwd },
    });

    let result;
    try {
      result = await runBounded(command, args, {
        cwd: workingDirectory,
        timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
        signal,
      });
    } catch (error) {
      await this.#fail(sessionId, CAPABILITIES.execute, GENERIC_RESOURCES.command, error, approvalRequestId);
      throw error;
    }
    await this.#emit({
      type: "capability.executed",
      sessionId,
      capability: CAPABILITIES.execute,
      resource: GENERIC_RESOURCES.command,
      approvalRequestId,
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  async #approve({ sessionId, capability, resource, reason, details }) {
    const requestId = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#emit({
      type: "approval.requested",
      requestId,
      sessionId,
      capability,
      resource,
      reason,
      createdAt,
    });

    let approved = false;
    try {
      if (this.#requestApproval) {
        const promptDetails = Object.freeze({
          ...details,
          ...(Array.isArray(details.args) ? { args: Object.freeze([...details.args]) } : {}),
        });
        const prompt = Object.freeze({
          requestId,
          sessionId,
          capability,
          resource,
          reason,
          createdAt,
          details: promptDetails,
        });
        approved = (await this.#requestApproval(prompt)) === true;
      }
    } catch {
      // Do not propagate provider error text: it may contain credentials or command data.
      approved = false;
    }

    await this.#emit({
      type: "approval.resolved",
      requestId,
      approved,
      decidedAt: new Date().toISOString(),
    });
    if (!approved) {
      await this.#deny(sessionId, capability, resource, requestId, "APPROVAL_DENIED");
      throw new SecurityError("APPROVAL_DENIED", "The requested capability was not approved");
    }
    return requestId;
  }

  async #deny(sessionId, capability, resource, approvalRequestId, errorCode = "SECURITY_DENIED") {
    await this.#emit({
      type: "capability.denied",
      sessionId,
      capability,
      resource,
      ...(approvalRequestId ? { approvalRequestId } : {}),
      errorCode,
      timestamp: new Date().toISOString(),
    });
  }

  async #fail(sessionId, capability, resource, error, approvalRequestId) {
    await this.#emit({
      type: "capability.failed",
      sessionId,
      capability,
      resource,
      ...(approvalRequestId ? { approvalRequestId } : {}),
      errorCode: typeof error?.code === "string" ? error.code : "OPERATION_FAILED",
      timestamp: new Date().toISOString(),
    });
  }

  #relativeResource(target) {
    const relative = path.relative(this.#root, target);
    return relative === "" ? "." : relative.split(path.sep).join("/");
  }

  #resolveLexically(requestedPath) {
    if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
      throw new TypeError("path must be a non-empty string without NUL bytes");
    }
    const target = path.resolve(this.#root, requestedPath);
    if (!isInside(this.#root, target)) {
      throw new SecurityError("PATH_OUTSIDE_WORKSPACE", "Path is outside the workspace");
    }
    return target;
  }

  async #resolveExistingFile(requestedPath) {
    const lexical = this.#resolveLexically(requestedPath);
    let canonical;
    try {
      canonical = await realpath(lexical);
    } catch {
      throw new SecurityError("PATH_UNAVAILABLE", "Workspace file is unavailable");
    }
    if (!isInside(this.#root, canonical)) {
      throw new SecurityError("PATH_OUTSIDE_WORKSPACE", "Resolved path is outside the workspace");
    }
    let info;
    try {
      info = await stat(canonical);
    } catch {
      throw new SecurityError("PATH_UNAVAILABLE", "Workspace file is unavailable");
    }
    if (!info.isFile()) throw new SecurityError("NOT_A_FILE", "Path does not identify a regular file");
    return canonical;
  }

  async #resolveExistingDirectory(requestedPath) {
    const lexical = this.#resolveLexically(requestedPath);
    let canonical;
    try {
      canonical = await realpath(lexical);
    } catch {
      throw new SecurityError("PATH_UNAVAILABLE", "Workspace directory is unavailable");
    }
    if (!isInside(this.#root, canonical)) {
      throw new SecurityError("PATH_OUTSIDE_WORKSPACE", "Resolved path is outside the workspace");
    }
    let info;
    try {
      info = await stat(canonical);
    } catch {
      throw new SecurityError("PATH_UNAVAILABLE", "Workspace directory is unavailable");
    }
    if (!info.isDirectory()) throw new SecurityError("NOT_A_DIRECTORY", "Path does not identify a directory");
    return canonical;
  }

  async #resolveWriteTarget(requestedPath) {
    const lexical = this.#resolveLexically(requestedPath);
    if (lexical === this.#root) throw new SecurityError("NOT_A_FILE", "Workspace root is not a file");

    const parent = path.dirname(lexical);
    let canonicalParent;
    try {
      canonicalParent = await realpath(parent);
    } catch {
      throw new SecurityError("PATH_UNAVAILABLE", "Workspace parent directory is unavailable");
    }
    if (!isInside(this.#root, canonicalParent)) {
      throw new SecurityError("PATH_OUTSIDE_WORKSPACE", "Resolved parent is outside the workspace");
    }
    if (!(await stat(canonicalParent)).isDirectory()) {
      throw new SecurityError("NOT_A_DIRECTORY", "Parent path is not a directory");
    }

    const target = path.join(canonicalParent, path.basename(lexical));
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new SecurityError("UNSAFE_WRITE_TARGET", "Write target must be a regular non-symlink file");
      }
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      if (error?.code !== "ENOENT") throw new SecurityError("PATH_UNAVAILABLE", "Workspace target is unavailable");
    }
    return target;
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId is required");
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
}

function runBounded(command, args, { cwd, timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new SecurityError("COMMAND_SPAWN_FAILED", "Command could not be started"));
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let finished = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 200);
      killTimer.unref?.();
    }, timeoutMs);

    const abortHandler = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 200);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    const stopForOutputLimit = () => {
      if (!outputExceeded) {
        outputExceeded = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 200);
        killTimer.unref?.();
      }
    };

    const collect = (destination) => (chunk) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        stopForOutputLimit();
        return;
      }
      destination.push(buffer);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    child.once("error", () => fail(new SecurityError("COMMAND_SPAWN_FAILED", "Command could not be started")));
    child.once("close", (exitCode, exitSignal) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (timedOut) return reject(new CommandTimeoutError(timeoutMs));
      if (aborted) return reject(new SecurityError("COMMAND_ABORTED", "Command was aborted"));
      if (outputExceeded) return reject(new OutputLimitError());
      if (exitCode !== 0) return reject(new CommandExitError(exitCode, exitSignal));
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });
  });
}

import crypto from "node:crypto";
import {
  hasUuSession,
  killUuSession,
  renameUuSession,
  validateDeviceId,
  validateSessionName,
} from "./cli.js";
import { extractFramedOutput, stripAnsi } from "./protocol.js";
import { spawnUuPty, type PtyTransport } from "./pty.js";
import { buildReadyProbe, buildWrappedCommand } from "./shell.js";
import type { UuExecResult, UuShell } from "./types.js";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const RING_MAX_CHARS = 32768;
const HANDSHAKE_TIMEOUT_MS = 18000;

interface QueuedExec {
  command: string;
  timeoutSec: number;
  maxBytes: number;
  resolve: (res: UuExecResult) => void;
}

interface ManagedSession {
  key: string;
  deviceId: string;
  sessionName: string;
  shell: UuShell;
  generation: number;
  state: "opening" | "ready" | "running" | "closed";
  transport: PtyTransport;
  cleanBuf: string;
  ringBuf: string;
  queue: QueuedExec[];
  active: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
  onUnexpectedExit?: (reason: string) => void;
}

export class UuSessionPool {
  private sessions = new Map<string, ManagedSession>();
  private openingPromises = new Map<string, Promise<ManagedSession>>();
  private shuttingDown = false;
  private nextGen = 1;

  private makeKey(deviceId: string, sessionName: string): string {
    return `${deviceId}:${sessionName}`;
  }

  private appendRing(entry: ManagedSession, chunk: string): void {
    entry.ringBuf += chunk;
    if (entry.ringBuf.length > RING_MAX_CHARS) {
      entry.ringBuf = entry.ringBuf.slice(-RING_MAX_CHARS);
    }
  }

  private resetIdleTimer(entry: ManagedSession): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.state === "closed" || entry.active || entry.queue.length > 0) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (!entry.active && entry.queue.length === 0) {
        this.closeLocalEntry(entry);
      }
    }, IDLE_TIMEOUT_MS);
    entry.idleTimer.unref?.();
  }

  private isEntryClosed(entry: ManagedSession): boolean {
    return entry.state === "closed";
  }

  private closeLocalEntry(entry: ManagedSession): void {
    if (entry.state === "closed") return;
    entry.state = "closed";
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.sessions.get(entry.key)?.generation === entry.generation) {
      this.sessions.delete(entry.key);
    }
    try {
      entry.transport.close();
    } catch { }
  }

  private async openSession(
    cliPath: string,
    deviceId: string,
    sessionName: string,
    shell: UuShell,
  ): Promise<ManagedSession> {
    const key = this.makeKey(deviceId, sessionName);
    const existing = this.sessions.get(key);
    if (existing && existing.state !== "closed") {
      if (existing.shell !== shell) {
        throw new Error(
          `Session "${sessionName}" is already open with shell "${existing.shell}" (requested "${shell}").`,
        );
      }
      return existing;
    }

    const inflight = this.openingPromises.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<ManagedSession> => {
      if (this.shuttingDown) {
        throw new Error("UU session pool is shutting down");
      }

      const existsRemote = await hasUuSession(cliPath, deviceId, sessionName);
      const args = existsRemote
        ? ["term", "-d", deviceId, "attach", sessionName]
        : ["term", "-d", deviceId, "new", sessionName, "--shell", shell];

      const transport = spawnUuPty(cliPath, args, { cols: 160, rows: 40 });
      const gen = this.nextGen++;
      const entry: ManagedSession = {
        key,
        deviceId,
        sessionName,
        shell,
        generation: gen,
        state: "opening",
        transport,
        cleanBuf: "",
        ringBuf: "",
        queue: [],
        active: false,
        idleTimer: null,
        lastUsedAt: Date.now(),
      };

      const unsubData = transport.onData((chunk) => {
        const cleaned = stripAnsi(chunk);
        entry.cleanBuf += cleaned;
        if (entry.cleanBuf.length > 262144) {
          entry.cleanBuf = entry.cleanBuf.slice(-131072);
        }
        this.appendRing(entry, cleaned);
      });

      const unsubExit = transport.onExit((code) => {
        const wasOpen = entry.state !== "closed";
        unsubData();
        unsubExit();
        this.closeLocalEntry(entry);
        if (wasOpen) {
          entry.onUnexpectedExit?.(`PTY exited unexpectedly (code=${code ?? "null"})`);
        }
      });

      this.sessions.set(key, entry);

      // Handshake: send split-marker readiness probe until matched or timed out
      const probeId = crypto.randomBytes(4).toString("hex");
      const readyMarker = `__UU_READY_${probeId}__`;
      const probeCmd = buildReadyProbe(shell, probeId);

      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const startedAt = Date.now();
          let probeTimer: ReturnType<typeof setInterval> | null = null;
          let checkTimer: ReturnType<typeof setInterval> | null = null;

          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (probeTimer) clearInterval(probeTimer);
            if (checkTimer) clearInterval(checkTimer);
            entry.onUnexpectedExit = undefined;
            if (err) reject(err);
            else resolve();
          };

          entry.onUnexpectedExit = (reason) => {
            finish(new Error(`Failed to open remote terminal "${sessionName}": ${reason}`));
          };

          const sendProbe = () => {
            if (settled || entry.state === "closed") return;
            transport.write(probeCmd);
          };

          // Initial short delay for UU client attach banner / remote shell startup
          setTimeout(sendProbe, 350);
          probeTimer = setInterval(sendProbe, 1800);
          checkTimer = setInterval(() => {
            if (entry.cleanBuf.includes(readyMarker)) {
              finish();
              return;
            }
            if (Date.now() - startedAt > HANDSHAKE_TIMEOUT_MS) {
              const tail = entry.ringBuf.slice(-400).trim();
              finish(
                new Error(
                  `Remote terminal handshake timed out (${HANDSHAKE_TIMEOUT_MS}ms).${tail ? ` Output tail: ${tail}` : ""}`,
                ),
              );
            }
          }, 80);
        });
      } catch (err) {
        this.closeLocalEntry(entry);
        throw err;
      }

      entry.state = "ready";
      entry.cleanBuf = "";
      entry.lastUsedAt = Date.now();
      this.resetIdleTimer(entry);
      return entry;
    })();

    this.openingPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.openingPromises.delete(key);
    }
  }

  async ensureSession(
    cliPath: string,
    deviceId: string,
    sessionName: string,
    shell: UuShell,
  ): Promise<{ ok: boolean; sessionName: string; shell: UuShell; error?: string }> {
    const id = validateDeviceId(deviceId);
    const name = validateSessionName(sessionName);
    try {
      const entry = await this.openSession(cliPath, id, name, shell);
      this.resetIdleTimer(entry);
      return { ok: true, sessionName: entry.sessionName, shell: entry.shell };
    } catch (err) {
      return {
        ok: false,
        sessionName: name,
        shell,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async exec(
    cliPath: string,
    deviceId: string,
    sessionName: string,
    shell: UuShell,
    command: string,
    timeoutSec = 60,
    maxBytes = 32768,
  ): Promise<UuExecResult> {
    const id = validateDeviceId(deviceId);
    const name = validateSessionName(sessionName);
    if (this.shuttingDown) {
      return {
        ok: false,
        status: "error",
        exitCode: null,
        output: "",
        truncated: false,
        error: "UU session pool is shutting down",
      };
    }

    let entry: ManagedSession;
    try {
      entry = await this.openSession(cliPath, id, name, shell);
    } catch (err) {
      return {
        ok: false,
        status: "disconnected",
        exitCode: null,
        output: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return new Promise<UuExecResult>((resolve) => {
      entry.queue.push({
        command,
        timeoutSec: Math.max(3, Math.min(600, timeoutSec)),
        maxBytes: Math.max(512, Math.min(262144, maxBytes)),
        resolve,
      });
      void this.drainQueue(entry);
    });
  }

  private async drainQueue(entry: ManagedSession): Promise<void> {
    if (entry.active || entry.state === "closed") return;
    const item = entry.queue.shift();
    if (!item) {
      this.resetIdleTimer(entry);
      return;
    }

    entry.active = true;
    entry.state = "running";
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    const res = await this.runSingleExec(entry, item);
    entry.active = false;
    entry.lastUsedAt = Date.now();
    if (!this.isEntryClosed(entry)) {
      entry.state = "ready";
    }
    item.resolve(res);

    if (this.isEntryClosed(entry)) {
      while (entry.queue.length > 0) {
        const rest = entry.queue.shift()!;
        rest.resolve({
          ok: false,
          status: "disconnected",
          exitCode: null,
          output: "",
          truncated: false,
          error: "Session closed after previous command failure/timeout",
        });
      }
      return;
    }

    void this.drainQueue(entry);
  }

  private runSingleExec(
    entry: ManagedSession,
    item: QueuedExec,
  ): Promise<UuExecResult> {
    const reqId = crypto.randomBytes(5).toString("hex");
    entry.cleanBuf = "";
    const wrapped = buildWrappedCommand(entry.shell, item.command, reqId);
    const timeoutMs = item.timeoutSec * 1000;

    return new Promise<UuExecResult>((resolve) => {
      let finished = false;
      let interrupted = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let abortTimer: ReturnType<typeof setTimeout> | null = null;

      const done = (result: UuExecResult) => {
        if (finished) return;
        finished = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortTimer) clearTimeout(abortTimer);
        entry.onUnexpectedExit = undefined;
        resolve(result);
      };

      entry.onUnexpectedExit = (reason) => {
        done({
          ok: false,
          status: "disconnected",
          exitCode: null,
          output: entry.ringBuf.slice(-2000),
          truncated: false,
          remoteMayStillBeRunning: true,
          error: reason,
        });
      };

      entry.transport.write(wrapped);

      pollTimer = setInterval(() => {
        const extracted = extractFramedOutput(
          entry.cleanBuf,
          reqId,
          item.maxBytes,
        );
        if (extracted.found) {
          done({
            ok: extracted.exitCode === 0,
            status: "completed",
            exitCode: extracted.exitCode,
            output: extracted.output,
            truncated: extracted.truncated,
          });
        }
      }, 60);

      timeoutTimer = setTimeout(() => {
        if (finished || interrupted) return;
        interrupted = true;
        entry.transport.sendCtrlC();
        abortTimer = setTimeout(() => {
          const partial = entry.cleanBuf.slice(-4000);
          this.closeLocalEntry(entry);
          done({
            ok: false,
            status: "timeout",
            exitCode: null,
            output: partial,
            truncated: false,
            remoteMayStillBeRunning: true,
            error: `Command timed out after ${item.timeoutSec}s (Ctrl+C sent; session closed to prevent desync)`,
          });
        }, 1600);
      }, timeoutMs);
    });
  }

  readRing(deviceId: string, sessionName: string, maxBytes = 16384): {
    connected: boolean;
    output: string;
    truncated: boolean;
  } {
    const key = this.makeKey(deviceId, sessionName);
    const entry = this.sessions.get(key);
    if (!entry) {
      return {
        connected: false,
        output: "",
        truncated: false,
      };
    }
    entry.lastUsedAt = Date.now();
    this.resetIdleTimer(entry);
    const buf = Buffer.from(entry.ringBuf, "utf8");
    if (buf.length <= maxBytes) {
      return { connected: true, output: entry.ringBuf, truncated: false };
    }
    let start = buf.length - maxBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    return {
      connected: true,
      output: buf.subarray(start).toString("utf8"),
      truncated: true,
    };
  }

  getActiveSessionNames(deviceId: string): string[] {
    const names: string[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.deviceId === deviceId && entry.state !== "closed") {
        names.push(entry.sessionName);
      }
    }
    return names;
  }

  async killSession(
    cliPath: string,
    deviceId: string,
    sessionName: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const key = this.makeKey(deviceId, sessionName);
    const entry = this.sessions.get(key);
    if (entry) {
      this.closeLocalEntry(entry);
    }
    return killUuSession(cliPath, deviceId, sessionName);
  }

  async renameSession(
    cliPath: string,
    deviceId: string,
    oldName: string,
    newName: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const key = this.makeKey(deviceId, oldName);
    const entry = this.sessions.get(key);
    if (entry) {
      this.closeLocalEntry(entry);
    }
    return renameUuSession(cliPath, deviceId, oldName, newName);
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const entry of Array.from(this.sessions.values())) {
      this.closeLocalEntry(entry);
    }
    this.sessions.clear();
  }
}

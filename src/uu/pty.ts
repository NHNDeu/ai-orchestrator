import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isJsShimPath } from "./cli.js";

export interface PtyTransport {
  write(text: string): void;
  resize(cols: number, rows: number): void;
  sendCtrlC(): void;
  close(): void;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
}

export interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
}

function resolveConptyHelperPath(): string {
  const candidates = [
    path.join(__dirname, "uu-conpty.exe"),
    path.resolve(__dirname, "..", "..", "dist", "uu-conpty.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Windows ConPTY helper not found (checked: ${candidates.join(", ")})`,
  );
}

class PipePtyTransport implements PtyTransport {
  private proc: ChildProcess;
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private exited = false;

  constructor(exe: string, args: string[]) {
    this.proc = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout?.on("data", (buf: Buffer) => {
      const txt = buf.toString("utf8");
      for (const cb of this.dataListeners) cb(txt);
    });
    this.proc.stderr?.on("data", (buf: Buffer) => {
      const txt = buf.toString("utf8");
      for (const cb of this.dataListeners) cb(txt);
    });
    this.proc.on("close", (code) => {
      if (this.exited) return;
      this.exited = true;
      for (const cb of this.exitListeners) cb(code);
    });
    this.proc.on("error", () => {
      if (this.exited) return;
      this.exited = true;
      for (const cb of this.exitListeners) cb(1);
    });
  }

  write(text: string): void {
    if (this.exited || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(text, "utf8");
  }

  resize(_cols: number, _rows: number): void {
    // Pipe transport has no terminal dimensions
  }

  sendCtrlC(): void {
    this.write("\x03");
  }

  close(): void {
    if (this.exited) return;
    try {
      this.proc.stdin?.end();
    } catch { }
    try {
      this.proc.kill();
    } catch { }
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
}

class WinConPtyTransport implements PtyTransport {
  private proc: ChildProcess;
  private lineBuf = "";
  private utf8Decoder = new StringDecoder("utf8");
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(code: number | null) => void>();
  private closed = false;
  private exited = false;

  constructor(helperExe: string, cols: number, rows: number, cliPath: string, args: string[]) {
    this.proc = spawn(
      helperExe,
      [String(cols), String(rows), cliPath, ...args],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.lineBuf += chunk.toString("utf8");
      const lines = this.lineBuf.split(/\r?\n/);
      this.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            type?: string;
            b64?: string;
            code?: number;
          };
          if (msg.type === "data" && typeof msg.b64 === "string") {
            const decoded = this.utf8Decoder.write(Buffer.from(msg.b64, "base64"));
            if (decoded) {
              for (const cb of this.dataListeners) cb(decoded);
            }
          } else if (msg.type === "exit") {
            this.emitExit(typeof msg.code === "number" ? msg.code : 0);
          }
        } catch {
          // Ignore malformed helper line
        }
      }
    });

    this.proc.on("close", (code) => {
      this.emitExit(code);
    });
    this.proc.on("error", () => {
      this.emitExit(1);
    });
  }

  private emitExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const rem = this.utf8Decoder.end();
    if (rem) {
      for (const cb of this.dataListeners) cb(rem);
    }
    for (const cb of this.exitListeners) cb(code);
  }

  private sendControl(payload: Record<string, unknown>): void {
    if (this.closed || this.exited || !this.proc.stdin?.writable) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    } catch { }
  }

  write(text: string): void {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    this.sendControl({ type: "write", b64 });
  }

  resize(cols: number, rows: number): void {
    this.sendControl({ type: "resize", cols, rows });
  }

  sendCtrlC(): void {
    this.write("\x03");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.exited && this.proc.stdin?.writable) {
      try {
        this.proc.stdin.write(`${JSON.stringify({ type: "close" })}\n`, "utf8");
        this.proc.stdin.end();
      } catch { }
    }
    const timer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.proc.kill();
        } catch { }
      }
    }, 1800);
    timer.unref?.();
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
}

export function spawnUuPty(
  cliPath: string,
  args: string[],
  opts: SpawnPtyOptions = {},
): PtyTransport {
  const cols = opts.cols ?? 160;
  const rows = opts.rows ?? 40;

  if (process.env.UU_PTY_MODE === "pipe" || isJsShimPath(cliPath)) {
    const exe = isJsShimPath(cliPath) ? process.execPath : cliPath;
    const finalArgs = isJsShimPath(cliPath) ? [cliPath, ...args] : args;
    return new PipePtyTransport(exe, finalArgs);
  }

  if (process.platform === "win32") {
    const helperExe = resolveConptyHelperPath();
    return new WinConPtyTransport(helperExe, cols, rows, cliPath, args);
  }

  // macOS / Linux PTY via /usr/bin/script
  if (process.platform === "darwin") {
    return new PipePtyTransport("/usr/bin/script", [
      "-q",
      "/dev/null",
      cliPath,
      ...args,
    ]);
  }

  return new PipePtyTransport("script", [
    "-qefc",
    [cliPath, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "),
    "/dev/null",
  ]);
}

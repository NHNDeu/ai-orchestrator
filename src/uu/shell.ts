import type { UuShell } from "./types.js";

/**
 * Build a readiness probe whose split literal will never match the echoed input line.
 */
export function buildReadyProbe(shell: UuShell, probeId: string): string {
  const halfA = "__UU_";
  const halfB = `READY_${probeId}__`;
  if (shell === "powershell") {
    return `Write-Output ("${halfA}" + "${halfB}")\r`;
  }
  if (shell === "cmd") {
    return `echo ${halfA}^${halfB}\r`;
  }
  return `printf '\\n${halfA}%s\\n' '${halfB}'\n`;
}

/**
 * Wrap an arbitrary multi-line command in Base64 + split-marker framing so
 * PTY local echo never triggers begin/end markers and Unicode/quotes survive intact.
 */
export function buildWrappedCommand(
  shell: UuShell,
  command: string,
  reqId: string,
): string {
  const beginSuffix = `BEGIN_${reqId}__`;
  const endPrefix = `END_${reqId}_`;

  if (shell === "powershell") {
    // UTF-8 with BOM so Windows PowerShell 5.1 parses Chinese/Unicode scripts cleanly
    const bomPrefixed = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(command, "utf8"),
    ]);
    const b64 = bomPrefixed.toString("base64");
    const lines = [
      `$__u_p = Join-Path $env:TEMP "uu_orch_${reqId}.ps1"`,
      `[IO.File]::WriteAllBytes($__u_p, [Convert]::FromBase64String('${b64}'))`,
      `try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}`,
      `Write-Output ("__UU_" + "${beginSuffix}")`,
      `$__u_ec = 0`,
      `try {`,
      `  $global:LASTEXITCODE = 0`,
      `  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $__u_p`,
      `  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__u_ec = [int]$LASTEXITCODE } elseif (-not $?) { $__u_ec = 1 }`,
      `} catch {`,
      `  Write-Output ($_ | Out-String)`,
      `  $__u_ec = 1`,
      `} finally {`,
      `  Remove-Item -LiteralPath $__u_p -Force -ErrorAction SilentlyContinue`,
      `}`,
      `Write-Output ("__UU_" + "${endPrefix}" + $__u_ec + "__")`,
    ];
    return `${lines.join("; ")}\r`;
  }

  if (shell === "cmd") {
    // Bootstrap via powershell -NoProfile so UTF-8/CRLF temp .cmd file & quoting are exact
    const crlfCmd = command.replace(/\r?\n/g, "\r\n");
    const b64 = Buffer.from(crlfCmd, "utf8").toString("base64");
    const psInner = [
      `$p = Join-Path $env:TEMP 'uu_orch_${reqId}.cmd'`,
      `[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('${b64}'))`,
      `Write-Output ('__UU_' + '${beginSuffix}')`,
      `$ec = 0`,
      `try { & cmd.exe /D /V:OFF /S /C ('"' + $p + '"'); $ec = [int]$LASTEXITCODE } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }`,
      `Write-Output ('__UU_' + '${endPrefix}' + $ec + '__')`,
    ].join("; ");
    const psB64 = Buffer.from(psInner, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -EncodedCommand ${psB64}\r`;
  }

  // zsh or bash (macOS / Linux)
  const lfCmd = command.replace(/\r\n/g, "\n");
  const b64 = Buffer.from(lfCmd, "utf8").toString("base64");
  const runner = shell === "zsh" ? "/bin/zsh -f" : "/bin/bash --noprofile --norc";
  const script = [
    `__u_f="/tmp/uu_orch_${reqId}.sh"`,
    `printf '%s' '${b64}' | (base64 -d 2>/dev/null || base64 -D) > "$__u_f"`,
    `printf '\\n__UU_%s\\n' '${beginSuffix}'`,
    `LC_ALL=\${LC_ALL:-en_US.UTF-8} LANG=\${LANG:-en_US.UTF-8} ${runner} "$__u_f"`,
    `__u_ec=$?`,
    `rm -f "$__u_f"`,
    `printf '\\n__UU_%s%d__\\n' '${endPrefix}' "$__u_ec"`,
  ].join("; ");
  return `${script}\n`;
}

export function defaultShellForPlatform(platform: string): UuShell {
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("darwin")) return "zsh";
  if (p.includes("linux")) return "bash";
  return "powershell";
}

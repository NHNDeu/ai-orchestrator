export function stripAnsi(raw: string): string {
  // Remove OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\)
  let s = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Remove CSI sequences (\x1b[...letter) and private modes
  s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Remove single ESC sequences (\x1b[@-Z\\-_] or charset G0/G1 \x1b[()][AB012])
  s = s.replace(/\x1b[()][AB012]/g, "");
  s = s.replace(/\x1b[@-Z\\-_]/g, "");
  // Remove stray BEL / NUL / BS
  s = s.replace(/[\x00\x07\x08]/g, "");
  // Normalize CRLF and bare CR
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return s;
}

export interface ExtractedOutput {
  found: boolean;
  beginFound: boolean;
  endFound: boolean;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const limit = Math.max(256, maxBytes);
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) {
    return { text, truncated: false };
  }
  // Keep tail or head? Keep head + notice or slice cleanly on UTF-8 boundary
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return {
    text: `${buf.subarray(0, end).toString("utf8")}\n... (output truncated at ${limit} bytes)`,
    truncated: true,
  };
}

export function extractFramedOutput(
  cleanedBuffer: string,
  reqId: string,
  maxBytes = 32768,
): ExtractedOutput {
  const beginMarker = `__UU_BEGIN_${reqId}__`;
  const endRe = new RegExp(`__UU_END_${reqId}_(-?\\d+)__`);

  const beginIdx = cleanedBuffer.indexOf(beginMarker);
  if (beginIdx === -1) {
    return {
      found: false,
      beginFound: false,
      endFound: false,
      exitCode: null,
      output: "",
      truncated: false,
    };
  }

  let bodyStart = beginIdx + beginMarker.length;
  if (cleanedBuffer[bodyStart] === "\n") {
    bodyStart += 1;
  }

  const afterBegin = cleanedBuffer.slice(bodyStart);
  const endMatch = endRe.exec(afterBegin);
  if (!endMatch) {
    return {
      found: false,
      beginFound: true,
      endFound: false,
      exitCode: null,
      output: "",
      truncated: false,
    };
  }

  const rawBody = afterBegin.slice(0, endMatch.index).replace(/\n$/, "");
  const exitCode = Number.parseInt(endMatch[1], 10);
  const { text, truncated } = truncateUtf8(rawBody, maxBytes);

  return {
    found: true,
    beginFound: true,
    endFound: true,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    output: text,
    truncated,
  };
}

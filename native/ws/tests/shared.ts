// Helpers both test sides share. Runs under Node (with real `ws`) and natively.
import { createHash } from "node:crypto";

/** Payload bytes that differ at every offset, so a misordered copy shows. */
export function pattern(length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

const SHORT_DATA_BYTES = 32;

function digest(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}

/** A stable one-line description of a message or event payload. */
export function describeData(data: unknown): string {
  if (typeof data === "string") {
    return data.length <= SHORT_DATA_BYTES ? `str:${JSON.stringify(data)}` : `str:${data.length}`;
  }
  if (data instanceof ArrayBuffer) {
    return `arraybuffer:${data.byteLength}:${digest(Buffer.from(data))}`;
  }
  if (Buffer.isBuffer(data)) {
    if (data.length <= SHORT_DATA_BYTES) return `buf:${JSON.stringify(data.toString("latin1"))}`;
    return `buf:${data.length}:${digest(data)}`;
  }
  return `other:${typeof data}`;
}

/** Message and code of an error, with port numbers masked. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `non-error:${typeof error}`;
  const message = error.message.replace(/:\d+/g, ":<port>");
  const code = "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
  return `${error.name}: ${message}${code}`;
}

export function describeReason(reason: unknown): string {
  return Buffer.isBuffer(reason) ? JSON.stringify(reason.toString()) : `other:${typeof reason}`;
}

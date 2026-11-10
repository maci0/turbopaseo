// A raw TCP WebSocket client for the server's handshake and protocol-error
// paths, which a conforming client never takes. Shared by both client programs.
import * as net from "node:net";

const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

/** A client frame (masked unless `masked` is false) with a payload under 126 bytes. */
export function clientFrame(opcode: number, payload: Buffer, masked = true): Buffer {
  const header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | payload.length]);
  if (!masked) return Buffer.concat([header, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ MASK[i & 3]!;
  return Buffer.concat([header, MASK, body]);
}

export function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

export function upgradeRequest(path: string, extraHeaders: string[], key = KEY): string {
  const lines = [
    `GET ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
  ];
  if (key !== "") lines.push(`Sec-WebSocket-Key: ${key}`);
  return [...lines, ...extraHeaders].join("\r\n") + "\r\n\r\n";
}

/** Server frames (unmasked, payload under 126 bytes) after the response head. */
export function describeServerBytes(bytes: Buffer): string {
  const text = bytes.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) return `incomplete head ${JSON.stringify(text)}`;
  const lines = text.slice(0, end).split("\r\n");
  const parts = [`status=${JSON.stringify(lines[0] ?? "")}`];
  for (const line of lines.slice(1)) {
    if (line.toLowerCase().startsWith("sec-websocket-version:")) parts.push(JSON.stringify(line));
  }
  let offset = end + 4;
  if ((lines[0] ?? "").includes(" 101 ")) {
    while (offset + 2 <= bytes.length) {
      const opcode = bytes[offset]! & 0x0f;
      const length = bytes[offset + 1]! & 0x7f;
      const payload = bytes.subarray(offset + 2, offset + 2 + length);
      offset += 2 + length;
      if (opcode === 0x8) parts.push(`close=${payload.length >= 2 ? payload.readUInt16BE(0) : 1005}`);
      else parts.push(`frame opcode=${opcode} ${JSON.stringify(payload.toString())}`);
    }
  } else {
    parts.push(`body=${JSON.stringify(text.slice(end + 4))}`);
  }
  return parts.join(" ");
}

/**
 * Connects, writes `first`, and calls `onBytes` with everything received so
 * far after each chunk; `onBytes` may write more. Calls `done` with all bytes
 * once the server closes the connection.
 */
export function rawExchange(
  port: number,
  first: Buffer,
  onBytes: (received: Buffer, socket: net.Socket) => void,
  done: (received: Buffer) => void,
): void {
  let received = Buffer.alloc(0);
  const socket = net.connect(port, "127.0.0.1", () => socket.write(first));
  socket.on("data", (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    onBytes(received, socket);
  });
  socket.on("error", () => socket.destroy());
  socket.on("end", () => socket.end());
  socket.on("close", () => done(received));
}

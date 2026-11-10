// A misbehaving WebSocket server on node:net, for the client's handshake and
// protocol-error paths. Shared by both peers. After a 101 it decodes the first
// frame the client sends back and logs a close frame's code as "S <url> ...".
import * as net from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MASKED_HI = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]);

function accept(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

function switching(acceptValue: string, upgrade: string): string {
  return (
    "HTTP/1.1 101 Switching Protocols\r\n" +
    `Upgrade: ${upgrade}\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Accept: ${acceptValue}\r\n\r\n`
  );
}

/** Logs the client's first frame when it is a close frame. */
function watchClientClose(socket: net.Socket, url: string): void {
  let pending = Buffer.alloc(0);
  let logged = false;
  socket.on("data", (chunk: Buffer) => {
    if (logged) return;
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 2) return;
    const opcode = pending[0]! & 0x0f;
    const length = pending[1]! & 0x7f;
    if (pending.length < 6 + length) return;
    logged = true;
    if (opcode !== 0x8) {
      console.log(`S ${url} client frame opcode=${opcode}`);
      return;
    }
    const mask = pending.subarray(2, 6);
    const payload = Buffer.from(pending.subarray(6, 6 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    console.log(`S ${url} client close ${code}`);
  });
}

function respond(socket: net.Socket, url: string, key: string): void {
  const path = url.split("?")[0] ?? "";
  const good = accept(key);
  if (path === "/hang") return;
  if (path === "/status-400") {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  if (path === "/bad-accept") {
    socket.write(switching("AAAAAAAAAAAAAAAAAAAAAAAAAAA=", "websocket"));
    return;
  }
  if (path === "/bad-upgrade") {
    socket.write(switching(good, "foo"));
    return;
  }
  socket.write(switching(good, "websocket"));
  watchClientClose(socket, url);
  if (path === "/invalid-utf8") socket.write(Buffer.from([0x81, 0x02, 0xff, 0xfe]));
  else if (path === "/bad-opcode") socket.write(Buffer.from([0x83, 0x00]));
  else if (path === "/masked") socket.write(MASKED_HI);
  else if (path === "/bad-close-code") socket.write(Buffer.from([0x88, 0x02, 0x03, 0xed]));
  else if (path === "/rsv1") socket.write(Buffer.from([0xc1, 0x00]));
  else if (path === "/ping-126") {
    const frame = Buffer.alloc(4 + 126);
    frame[0] = 0x89;
    frame[1] = 126;
    frame.writeUInt16BE(126, 2);
    socket.write(frame);
  }
}

export function startRawServer(onListening: (port: number) => void): net.Server {
  const server = net.createServer((socket: net.Socket) => {
    let head = "";
    let answered = false;
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.end());
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      answered = true;
      const lines = head.slice(0, end).split("\r\n");
      const url = (lines[0] ?? "").split(" ")[1] ?? "";
      let key = "";
      for (const line of lines) {
        if (line.toLowerCase().startsWith("sec-websocket-key:")) key = line.slice(18).trim();
      }
      respond(socket, url, key);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("raw server: no port");
    onListening(address.port);
  });
  return server;
}

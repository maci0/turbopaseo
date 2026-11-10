// Starts every server a client run needs and prints one line:
//   ENDPOINTS <wsPort> <unixPath> <tlsPort> <rawPort> <refusedPort> <smallPort>
// then server-side log lines ("S ..."). Runs until killed.
// argv: unixPath certDir. All TCP listeners bind 127.0.0.1 on port 0.
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { startRawServer } from "./raw-server.ts";

/**
 * Attaches a WebSocket server to `server`; `port` reads its TCP port once
 * known. `small` asks for the server of handleSmallConnection.
 */
export type AttachServer = (server: http.Server, port: () => number, small: boolean) => void;

function plainResponse(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("plain http");
}

function listenTcp(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("peer: no port");
      resolve(address.port);
    });
  });
}

function refusedPort(): Promise<number> {
  const server = net.createServer();
  return listenTcp(server).then(
    (port) => new Promise<number>((resolve) => server.close(() => resolve(port))),
  );
}

export async function startPeer(attach: AttachServer): Promise<void> {
  const unixPath = process.argv[2] ?? "";
  const certDir = process.argv[3] ?? "";

  const tcp = http.createServer(plainResponse);
  let tcpPort = 0;
  attach(tcp, () => tcpPort, false);
  tcpPort = await listenTcp(tcp);

  rmSync(unixPath, { force: true });
  const unix = http.createServer(plainResponse);
  attach(unix, () => 0, false);
  await new Promise<void>((resolve) => unix.listen(unixPath, () => resolve()));

  const secure = https.createServer(
    {
      key: readFileSync(`${certDir}/key.pem`),
      cert: readFileSync(`${certDir}/cert.pem`),
    },
    plainResponse,
  );
  let tlsPort = 0;
  attach(secure, () => tlsPort, false);
  tlsPort = await listenTcp(secure);

  const small = http.createServer(plainResponse);
  attach(small, () => 0, true);
  const smallPort = await listenTcp(small);

  const rawPort = await new Promise<number>((resolve) => startRawServer(resolve));
  const refused = await refusedPort();
  console.log(`ENDPOINTS ${tcpPort} ${unixPath} ${tlsPort} ${rawPort} ${refused} ${smallPort}`);
}

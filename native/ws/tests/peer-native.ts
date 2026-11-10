// The peer servers with this package's WebSocketServer, built natively.
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "../index.ts";
import { startPeer } from "./peer.ts";
import {
  handleConnection,
  handleSmallConnection,
  selectProtocol,
  verifySmallClient,
  type ServerSocketView,
} from "./scenario-server.ts";

const SMALL_MAX_PAYLOAD = 1000;

void startPeer((server, port, small) => {
  if (small) {
    const wss = new WebSocketServer({
      server,
      path: "/small",
      maxPayload: SMALL_MAX_PAYLOAD,
      verifyClient: verifySmallClient,
    });
    wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      handleSmallConnection(ws as unknown as ServerSocketView, request, wss.clients.size);
    });
    return;
  }
  const wss = new WebSocketServer({ server, handleProtocols: selectProtocol });
  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    handleConnection(ws as unknown as ServerSocketView, request, port());
  });
});

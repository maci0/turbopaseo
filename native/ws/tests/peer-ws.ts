// The peer servers with npm `ws`'s WebSocketServer under Node (run with tsx):
// the reference behavior. Same servers as peer-native.ts.
import { WebSocketServer } from "ws";
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
    wss.on("connection", (ws, request) => {
      handleSmallConnection(ws as unknown as ServerSocketView, request, wss.clients.size);
    });
    return;
  }
  const wss = new WebSocketServer({ server, handleProtocols: selectProtocol });
  wss.on("connection", (ws, request) => {
    handleConnection(ws as unknown as ServerSocketView, request, port());
  });
});

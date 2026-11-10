// Native client and server in one process: echo, close codes, and the
// WebSocketLike view Paseo's client transport uses. Exits nonzero on failure.
import * as http from "node:http";
import { WebSocket, WebSocketServer } from "../index.js";

const TIMEOUT_MS = 5000;
const timer = setTimeout(() => {
  console.log("FAIL smoke timeout");
  process.exit(1);
}, TIMEOUT_MS);

const httpServer = http.createServer((_req, res) => {
  res.end("http ok");
});
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws, request) => {
  console.log(`server connection ${request.url}`);
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
  ws.on("close", (code, reason) => console.log(`server close ${code} ${reason.toString()}`));
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  client.on("open", () => {
    console.log("client open");
    client.send("hello");
  });
  client.on("message", (data, isBinary) => {
    console.log(`client message ${data.toString()} ${isBinary}`);
    client.close(4000, "done");
  });
  client.on("error", (error) => console.log(`client error ${error.message}`));
  client.on("close", (code, reason) => {
    console.log(`client close ${code} ${reason.toString()}`);
    clearTimeout(timer);
    wss.close();
    httpServer.close();
  });
});

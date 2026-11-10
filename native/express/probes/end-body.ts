// Shows how `res.end(body)` frames a body: through the Writable it is one
// chunk then an end, so node:http sends it chunked where express sends
// Content-Length. Prints the response headers that differ.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import express from "../express.js";

const app = express();
app.get("/end-body", (_req, res) => {
  res.end("plain body");
});
const server = createServer(app);
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const req = request({ host: "127.0.0.1", port, path: "/end-body" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log(
        JSON.stringify({
          status: res.statusCode,
          contentLength: res.headers["content-length"] ?? null,
          transferEncoding: res.headers["transfer-encoding"] ?? null,
          body,
        }),
      );
      server.close();
    });
  });
  req.end();
});

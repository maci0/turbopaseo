// Probes the MCP SDK's StreamableHTTPServerTransport behind ../express.ts the
// way bootstrap.ts uses it (stateless, one server per request), handed the
// raw node:http objects and the body express.json() parsed.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "../express.js";

const app = express();
app.use(express.json());
app.post("/mcp/agents", async (req, res) => {
  const server = new McpServer({ name: "probe", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: false,
  });
  await server.connect(transport);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(req.raw, res.raw, req.body);
});

const httpServer = createServer(app);

function post(port: number, body: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp/agents",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve(`${res.statusCode} ${String(res.headers["content-type"])}\n${text}`);
        });
      },
    );
    req.end(body);
  });
}

httpServer.listen(0, "127.0.0.1", () => {
  const port = (httpServer.address() as AddressInfo).port;
  void (async () => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "probe-client", version: "1.0.0" },
      },
    });
    console.log(await post(port, initialize));
    httpServer.close();
  })();
});

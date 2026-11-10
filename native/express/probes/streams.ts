// Probes how a stream can be moved into a ServerResponse under scriptc,
// which lowers neither pipe() nor pipeline() into one.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";

const file = process.argv[2] ?? "";
const SLOW_READER_DELAY_MS = 1000;
let maxPending = 0; // largest RSS seen after a write

// Writes each chunk as it arrives; scriptc lowers no write callback.
function pump(source: Readable, res: ServerResponse): void {
  source.on("data", (chunk: Buffer) => {
    res.write(chunk);
    maxPending = Math.max(maxPending, process.memoryUsage().rss);
  });
  source.on("end", () => {
    res.end();
  });
  res.on("close", () => {
    source.destroy();
  });
}

function headersFor(kind: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  headers["content-type"] = "text/plain";
  headers["x-kind"] = kind;
  headers["x-list"] = ["a", "b"];
  return headers;
}

const server = createServer((req, res) => {
  if (req.url === "/pump") {
    void stat(file).then((stats) => {
      res.setHeader("content-length", stats.size);
      res.writeHead(200, headersFor("pump"));
      pump(createReadStream(file), res);
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let size = 0;
      // A slow reader: the server's writes outpace the socket meanwhile.
      res.pause();
      setTimeout(() => {
        res.resume();
      }, SLOW_READER_DELAY_MS);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      res.on("end", () => {
        resolve(`${res.statusCode} ${String(res.headers["x-kind"])} ${String(res.headers["x-list"])} ${size}`);
      });
    });
    req.end();
  });
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  void (async () => {
    const startRss = process.memoryUsage().rss;
    console.log("pump", await get(port, "/pump"), "rssGrowthMiB", Math.round((maxPending - startRss) / 1048576));
    server.close();
  })();
});

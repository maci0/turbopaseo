// Does scriptc's node:http server emit 'upgrade' with a usable socket, and do
// plain requests on the same server still reach the request listener?
// Listens on 127.0.0.1:0. Step 1: a plain GET over node:net. Step 2: an Upgrade
// request with 5 trailing bytes in the same write (they must arrive as `head`),
// then a write after the 101 that the server echoes. Exits after 5 s regardless.
//
// The listener's second parameter must be typed `net.Socket`: a `Duplex`
// parameter (the type @types/node declares) is refused with SC1090.
import * as http from "node:http";
import * as net from "node:net";

const PROBE_TIMEOUT_MS = 5000;

const server = http.createServer((req, res) => {
  console.log(`request event: ${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain", connection: "close" });
  res.end("plain");
});

server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  console.log(`upgrade event: ${req.url} head=${JSON.stringify(head.toString())}`);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (chunk: Buffer) => {
    console.log(`server socket data: ${chunk.toString()}`);
    socket.write("echo:" + chunk.toString());
  });
});

const timer = setTimeout(() => {
  console.log("probe timeout");
  process.exit(2);
}, PROBE_TIMEOUT_MS);

function plainRequest(port: number, done: () => void): void {
  const client = net.connect(port, "127.0.0.1", () => {
    client.write("GET /plain HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  });
  let seen = "";
  client.on("data", (chunk: Buffer) => {
    seen += chunk.toString();
  });
  client.on("close", () => {
    console.log(`plain response status line: ${JSON.stringify(seen.split("\r\n")[0])}`);
    console.log(`plain response body has plain: ${seen.includes("plain")}`);
    done();
  });
}

function upgradeRequest(port: number, done: () => void): void {
  const client = net.connect(port, "127.0.0.1", () => {
    client.write(
      "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\nEXTRA",
    );
  });
  let seen = "";
  let sentAfterUpgrade = false;
  client.on("data", (chunk: Buffer) => {
    seen += chunk.toString();
    if (seen.startsWith("HTTP/1.1 101") && !sentAfterUpgrade) {
      sentAfterUpgrade = true;
      client.write("ping");
    }
    if (seen.includes("echo:ping")) {
      console.log("RESULT upgrade works");
      client.destroy();
      done();
    }
  });
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  plainRequest(address.port, () => {
    upgradeRequest(address.port, () => {
      clearTimeout(timer);
      server.close();
    });
  });
});

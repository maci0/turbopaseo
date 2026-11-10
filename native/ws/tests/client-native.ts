// The client scenarios against this package, built natively by test.sh.
// argv: wsPort unixPath tlsPort rawPort refusedPort smallPort caFile [scenario...]
import { readFileSync } from "node:fs";
import { WebSocket, type SendOptions } from "../index.ts";
import {
  runClientScenarios,
  type ClientSocketView,
  type ClientTestOptions,
  type Endpoints,
} from "./client-scenarios.ts";

type SendData = string | Uint8Array | ArrayBuffer;
type SendCallback = (error?: Error) => void;

/** The shape of Paseo's BudgetedWebSocket (packages/client/src/node/index.ts). */
class BudgetedWebSocket extends WebSocket {
  sentBytes = 0;

  override send(data: SendData, cb?: SendCallback): void;
  override send(data: SendData, options: SendOptions, cb?: SendCallback): void;
  override send(
    data: SendData,
    optionsOrCallback?: SendOptions | SendCallback,
    cb?: SendCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : cb;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    this.sentBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    super.send(data, options ?? {}, (error) => {
      console.log(`C budgeted send settled bytes=${this.sentBytes} error=${error instanceof Error}`);
      callback?.(error);
    });
  }
}

const args = process.argv.slice(2);
const endpoints: Endpoints = {
  wsPort: Number(args[0]),
  unixPath: args[1] ?? "",
  tlsPort: Number(args[2]),
  rawPort: Number(args[3]),
  refusedPort: Number(args[4]),
  smallPort: Number(args[5]),
  ca: readFileSync(args[6] ?? "", "utf8"),
};

function create(
  url: string,
  protocols: string[] | undefined,
  options: ClientTestOptions,
  budgeted: boolean,
): ClientSocketView {
  const clientOptions = {
    headers: options.headers,
    maxPayload: options.maxPayload,
    handshakeTimeout: options.handshakeTimeout,
    ca: options.ca,
  };
  if (budgeted) {
    const socket = new BudgetedWebSocket(url, protocols, clientOptions);
    return socket as unknown as ClientSocketView;
  }
  const socket = new WebSocket(url, protocols, clientOptions);
  return socket as unknown as ClientSocketView;
}

void runClientScenarios(create, endpoints, args.slice(7));

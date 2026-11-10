// Drives Paseo's real src/server/logger.ts: logs every level, child bindings, errors,
// redacted fields and long messages. Usage: log-probe <json|pretty> <stdout|file> [file path]
import pino from "pino";
import { createChildLogger, createRootLogger } from "../src/server/logger.js";

const format = process.argv[2] === "pretty" ? "pretty" : "json";
const target = process.argv[3] === "file" ? "file" : "stdout";
const filePath = process.argv[4] ?? "";

class ProbeError extends Error {
  readonly code = "EPROBE";
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

class UnnamedError extends Error {}

const root = createRootLogger(
  {
    log: {
      level: "trace",
      console: { level: "trace", format },
      ...(target === "file" ? { file: { level: "trace", path: filePath } } : {}),
    },
  },
  { paseoHome: process.cwd(), file: target === "file" },
);
const named = createChildLogger(root, "probe");
const logger = named.child({ module: "logging", component: "probe", attempt: 1 });

logger.trace("trace message");
logger.debug({ count: 2, flag: true, nothing: null }, "debug message");
logger.info({ list: [1, "two", { three: 3 }], nested: { a: { b: { c: 1 } } } }, "info message");
logger.warn(
  { ratio: 0.5, notANumber: Number.NaN, infinite: Number.POSITIVE_INFINITY },
  "warn message",
);
logger.error({ err: new Error("plain failure") }, "error with err");
logger.error(new ProbeError("thrown probe error"), "error as first argument");
logger.error(new UnnamedError("unnamed subclass"));
logger.error({ error: new Error("under the error key") }, "error key");
logger.error({ err: new Error("outer", { cause: new Error("inner cause") }) }, "error with cause");
logger.warn({ err: "just a string" }, "string err");
logger.info({ err: new ProbeError("message from err") });
logger.info(
  {
    authorization: "Bearer top-secret",
    Authorization: "Bearer TOP",
    "sec-websocket-protocol": "paseo.token.abc",
    "Sec-WebSocket-Protocol": "paseo.token.DEF",
    headers: {
      authorization: "Bearer nested",
      host: "localhost",
      "sec-websocket-protocol": "nested-token",
      "Sec-WebSocket-Protocol": "nested-token-2",
    },
    req: { headers: { Authorization: "Bearer req", "user-agent": "probe" }, url: "/ws" },
    kept: "visible",
  },
  "redacted fields",
);
logger
  .child({ authorization: "dropped", headers: { authorization: "x", keep: "y" } })
  .info("redacted bindings");
const longMessage = `${"long message ".repeat(20)}with "quotes", a backslash \\ , a tab\t, a newline\n and unicode é中`;
logger.info({ text: longMessage }, longMessage);
logger.info({ msg: "message inside fields", other: 1 });
logger.info("format %s and %d and %j and %o and %% done", "str", 42, { j: 1 }, "quoted");
logger.info({ when: new Date(0), undef: undefined, big: 12 }, "date and undefined");
const circular: Record<string, unknown> = { name: "loop" };
circular.self = circular;
logger.info({ circular }, "circular");
logger.info({ big: 12345678901234567890n }, "bigint");
logger.info({ level: "shadow", time: "shadow", pid: "shadow" }, "shadowing keys");
logger.child({ module: "again" }).info({ module: "duplicate" }, "duplicate keys");
logger.info({ empty: {}, emptyList: [] }, "");
logger.info(12345);
logger.info(null);
logger.info("%i and %f and %O and %x and %s", 3.7, "2.5", { o: [1] }, "unused");
logger.info({ first: 1 }, { second: 2 }, "extra");
logger.error(
  { err: new AggregateError([new Error("first"), new TypeError("second")], "many failed") },
  "aggregate error",
);
logger.error({ err: { message: "plain object with message", code: 7 } }, "error-like object");
const functionCause: Error = new Error("verror style");
functionCause.cause = () => new Error("from a function");
logger.error({ err: functionCause }, "function cause");
const assignedCause: Error = new Error("assigned cause");
assignedCause.cause = new RangeError("enumerable cause");
logger.error({ err: assignedCause }, "enumerable cause");
logger.child({ err: new Error("bound error") }).info("err binding");
let unknownLevel = "";
try {
  pino({ level: "loud" });
} catch (error) {
  unknownLevel = error instanceof Error ? error.message : String(error);
}
logger.warn(
  {
    unknownLevel,
    traceEnabled: logger.isLevelEnabled("trace"),
    silentEnabled: logger.isLevelEnabled("silent"),
    bogusEnabled: logger.isLevelEnabled("bogus"),
  },
  "levels",
);

const worker = pino({ level: "info" }).child({ module: "speech", component: "local-worker" });
worker.debug("hidden");
worker.info({ model: "x" }, "worker style logger");
const upper = pino({ level: "WARN" });
upper.info("hidden");
upper.warn("uppercase level");
const silent = pino({ level: "silent" });
silent.fatal("never");

logger.fatal({ reason: "probe end" }, "fatal message");

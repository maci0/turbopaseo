# native/ws

An RFC 6455 WebSocket client and server written on `node:net` and `node:tls`, for scriptc
builds of Paseo. Node builds keep npm `ws`; native builds load this module in its place.

npm `ws` cannot run in a scriptc binary: its client handshake calls `http.request()` with
`createConnection`, which scriptc's `node:http` rejects at run time (llms.txt, "Unix domain
sockets and request options"). This module does the HTTP/1.1 Upgrade itself over a raw
socket and keeps the `ws` 8.20 member names, event names, and argument shapes that Paseo
uses, so Paseo's source compiles against it unchanged (see [Selecting it](#selecting-it)).

| File | Role |
| --- | --- |
| `client.ts` | `WebSocket`: client handshake, framing, close handshake, event surface; also the server-side socket |
| `server.ts` | `WebSocketServer`: `server` (attach to `node:http`'s `'upgrade'`) or `noServer` with `handleUpgrade()` |
| `index.ts` | re-exports both, the module that replaces `ws` |
| `test.sh` | builds the native test programs and compares them against npm `ws` |
| `tests/` | shared scenarios, peers, expected logs (`tests/expected/`) |
| `probes/` | the scriptc probes this design rests on |

`node_modules` is a symlink to `work/paseo/node_modules` (for `@types/node`, npm `ws`, and
`tsx`); it is gitignored. Create it with
`ln -s ../../work/paseo/node_modules native/ws/node_modules`.

## Test

```console
$ ./test.sh
ws-ws: 183 client lines, 93 server lines
ws-native: 183 client lines, 93 server lines
native-ws: 183 client lines, 93 server lines
native-native: 183 client lines, 93 server lines
PASS
```

`test.sh` builds `tests/client-native.ts`, `tests/peer-native.ts`, `tests/smoke.ts` and
`probes/http-upgrade.ts` with `scriptc build ... --optimization dev --node-islands=off`
from this directory, into `<root>/.scratch/nativews/bin` (`OUT_DIR` overrides the root;
`SCRIPTC` the compiler). It generates a self-signed certificate for `localhost` with
`openssl`, then runs 48 client scenarios in four pairings:

| Pairing | Server | Client |
| --- | --- | --- |
| `ws-ws` | npm `ws` under Node (tsx) | npm `ws` under Node: the reference |
| `ws-native` | npm `ws` | this client, native |
| `native-ws` | this server, native | npm `ws` |
| `native-native` | this server, native | this client, native |

Both sides log every event they see (`C <scenario> ...` on the client, `S <url> ...` on
the server). Each pairing's client log and server log must equal `tests/expected/client.txt`
and `tests/expected/server.txt` line for line, so the native client and server are held to
the event order, close codes, reasons, error classes, messages, and error `code`s of real
`ws`. `UPDATE_EXPECTED=1` regenerates the expected logs from `ws-ws`; `PAIRINGS="ws-native"`
runs a subset. Every process runs under `timeout`, each scenario fails as `TIMEOUT` after
10 s, and the script exits nonzero on any diff, crash, or timeout. Changing
`CLOSE_ABNORMAL` from 1006 to 1001 fails `ws-native` with 20 differing lines.

The scenarios (`tests/client-scenarios.ts`):

- echo of text, binary, empty text and binary, payloads of 125, 126, 127, 65535, 65536,
  70000 and 5 MiB bytes, and 126-character text; `bufferedAmount` before, right after,
  and once an 8 MiB send is echoed; the send callback
- fragmented messages sent by the client (`fin: false`) and by the server, including a
  300 000-byte message in three fragments
- server ping (auto pong, `'ping'` event), client ping (`'pong'` event)
- close started by the server (4002 with reason; no status, read as 1005), by the client
  (4001), a second `close()` while closing, `send()` after `close()` (callback error,
  `bufferedAmount`), `terminate()`, `close()` and `send()`/`ping()` while connecting,
  invalid close code, a 124-byte reason, a 126-byte ping
- connection refused, a wrong `Sec-WebSocket-Accept`, a 400 response, a wrong `Upgrade`
  header, handshake timeout (a raw server that never answers)
- protocol errors from a raw server: invalid UTF-8 text (1007), opcode 3, a masked server
  frame, close code 1005 on the wire, RSV1 set, a 126-byte ping (all 1002); the raw server
  logs the close code the client sends back; `maxPayload` exceeded (1009)
- subprotocol negotiation, the server choosing none, custom headers and the `Host` header
- invalid URL protocol, a URL fragment, invalid and duplicate subprotocols, a header value
  with CRLF
- `ws+unix://<path>:/echo`, `wss://` with a `ca`, `wss://` against an untrusted certificate
- `addEventListener`/`removeEventListener` with `binaryType = "arraybuffer"` and the close
  event's `code`, `reason`, `wasClean`
- Paseo's own `createWebSocketTransportFactory`
  (`work/paseo/packages/client/src/daemon-client-websocket-transport.ts`, imported as is)
  over a subclass with an overridden `send`, shaped as Paseo's `BudgetedWebSocket`
- server paths over raw TCP: frames in the same packet as the handshake (`head`), an
  unmasked client frame, a missing `Sec-WebSocket-Key`, version 12, a path the server's
  `path` option rejects; and with the client: `verifyClient` rejecting with 403,
  server-side `maxPayload`, `pause()`/`resume()` holding messages until resume

`probes/http-upgrade.ts` and `tests/smoke.ts` run first; `test.sh` checks their output lines.

## What is implemented

Client (`new WebSocket(url, protocols?, options?)`, `ws:`, `wss:`, `http:`, `https:`,
`ws+unix:` URLs):

- handshake with a random key, `Sec-WebSocket-Accept`, `Upgrade` and subprotocol checks,
  custom headers (validated as `node:http` validates them), `handshakeTimeout`,
  `'upgrade'` and `'unexpected-response'` events, ws's error messages
- masked frames, text and binary, fragmentation in both directions (`send(data, { fin })`),
  ping and pong with automatic pong, close handshake with code and reason, the 30 s close
  timeout, `terminate()`, `bufferedAmount`, `maxPayload` (default 100 MiB), UTF-8
  validation of text messages and close reasons, ws's frame checks with its messages and
  `code`s (`WS_ERR_*`)
- `on`/`once`/`off`/`removeListener`/`listenerCount` with typed overloads per event,
  `addEventListener`/`removeEventListener`, `onopen`/`onmessage`/`onclose`/`onerror`,
  `binaryType`, `readyState`, `protocol`, `url`, `pause()`/`resume()`, `WebSocket.OPEN` and
  the other ready-state statics; subclassable, including an overridden `send`

Server (`new WebSocketServer(options)`): `server` or `noServer`, `path`, `maxPayload`,
`clientTracking` and `clients`, `handleProtocols`, the two-argument `verifyClient`,
`handleUpgrade()`, `shouldHandle()`, `close(callback)`, the `'connection'` event, and ws's
rejection responses (405, 400, 401/`verifyClient` code, 503). Server sockets are
`WebSocket` instances that expect masked frames and send unmasked ones.

## Differences from ws

- No permessage-deflate; `perMessageDeflate: true` throws. No redirects
  (`followRedirects`), no `agent` (throws when set: Paseo passes one only when a proxy is
  configured), no URL credentials (throws), no `origin` or `protocolVersion` options, no
  `autoPong: false`, no `skipUTF8Validation`. `autoSelectFamilyAttemptTimeout` is accepted
  and ignored; one address is dialed.
- `'message'` listeners always receive a `Buffer`; `binaryType = "arraybuffer"` changes only
  `MessageEvent.data` (addEventListener and `onmessage`). ws's `"fragments"` and `"blob"`
  binary types are not implemented.
- Listeners must be listed events: `open`, `message`, `close`, `error`, `ping`, `pong`,
  `upgrade`, `unexpected-response`; any other name throws a `TypeError`. There is no
  `emit`. `WebSocketServer` takes only `'connection'` (`close(callback)` covers `'close'`);
  it has no `'headers'`, `'listening'`, `'error'`, or `'wsClientError'`, no `port` option,
  and `verifyClient`'s `info` has `origin` and `req` but no `secure` (scriptc can test a
  `net.Socket` for TLS neither with `in` nor with `instanceof tls.TLSSocket`).
- `'unexpected-response'` passes `null` where ws passes the `ClientRequest`, and a
  `HandshakeResponse` (`statusCode`, `statusMessage`, lowercased `headers`, `destroy()`)
  where ws passes an `IncomingMessage`; its body is not readable. `'upgrade'` passes the
  same object.
- Send callbacks receive `undefined` on success; ws passes `null`.
- `addEventListener` listeners get `WebSocketEvent`, `WebSocketMessageEvent`,
  `WebSocketCloseEvent`, `WebSocketErrorEvent` objects with ws's fields; the `on*`
  properties are plain fields that run after the listeners, where ws registers them as
  listeners in assignment order.
- `readyState` and `bufferedAmount` are data fields, refreshed after each write and write
  callback; ws computes them on read. `pause()` also stops parsing frames already
  buffered.

## scriptc 0.4.10 limits met here

| Limit | Where | Workaround |
| --- | --- | --- |
| A class extending `EventEmitter` and viewed through a loose interface (`as unknown as WebSocketLike`) compiles, but listeners registered through the view never run; with an `on`-only interface the cast fails with SC2002. | `probes/events.ts` (natively the two `loose ...` lines Node prints are missing), `probes/events-view.ts` | The class keeps its own listener lists; `probes/registry.ts` shows views reaching them. |
| Overriding an `EventEmitter` member is refused (SC1090 "overriding the EventEmitter member 'on'"), and `EventEmitter`'s own `(...args: any[])` listeners must annotate every parameter (SC2020). | earlier probes, since removed (diagnostics quoted) | Same: no `EventEmitter` base. |
| A union of listener types as the overload implementation's parameter: a zero-parameter listener registered under `'close'` throws at run time ("a '() => void' value is not representable in the target union"); `(...args: never[]) => void` is refused at every call (SC1090). | `probes/overload-arity.ts` | The implementation takes `listener: unknown` and casts per event. |
| A union of only fixed-signature function types cannot be cast to one arm (SC1090). | `WebSocketServer.on` | It takes only `'connection'`. |
| A fixed-parameter listener cannot be stored in a `(...args: unknown[]) => void` slot (SC1090 "variadic function values where another signature is expected"). | `probes/registry.ts` header | Typed per-event lists. |
| `Map<K, V>.get()` where `V` is a function type with parameters fails to lower (SC2003 "union conversion has no unambiguous layout mapping"). | `addEventListener` bookkeeping | An array of `EventTargetEntry` records with a `detach` closure. |
| An `EventEmitter` `"message"` payload typed `Buffer \| ArrayBuffer` throws when emitted ("expected Uint8Array at $, got ArrayBuffer"). | an earlier `probes/events.ts` | `'message'` emits Buffers; the ArrayBuffer is built only for `MessageEvent.data` (`unknown`). |
| `Socket.off` has no lowering (SC2020). | handshake data listener | It stays registered and returns once the socket is open. |
| `instanceof tls.TLSSocket` and `in` on a `net.Socket` are refused (SC1090). | `verifyClient` `secure` | Dropped. |
| `node:http` `'upgrade'` needs `@types/node` in the program and a listener typed `(req: IncomingMessage, socket: net.Socket, head: Buffer)`; a `Duplex` socket parameter is refused (SC1090), and the bundled fallback declarations declare no server `'upgrade'` (SC0001). | `probes/http-upgrade.ts`, `tsconfig.json` (`"types": ["node"]`) | Listener typed with `net.Socket`. |
| A JS file cannot `require()` a `.ts` module (SC1010). | `probes/select.sh` | Select by tsconfig `paths` (below). |

## node:http and upgrades

scriptc's `node:http` server does emit `'upgrade'` with a usable socket:
`probes/http-upgrade.ts` serves a plain GET and an Upgrade request on one server; the
Upgrade's trailing bytes arrive as `head`, and the socket echoes data written after the 101.
Native and Node print the same lines:

```
request event: GET /plain
plain response status line: "HTTP/1.1 200 OK"
plain response body has plain: true
upgrade event: /ws head="EXTRA"
server socket data: ping
RESULT upgrade works
```

So `WebSocketServer({ server })` attaches to the same `http.Server` that Express serves,
as Paseo's `createWebSocketServer` does; no second listener or hand-written request parser
is needed. The `native-*` pairings run the server this way, including on a Unix socket and
an `https.Server`.

## Selecting it

Two mechanisms were probed (`probes/select.sh`, fixtures in `.scratch/nativews/select`):

- tsconfig `paths` (works): with `"paths": { "fakews": ["<abs>/native/ws/index.ts"] }` in
  the entry's tsconfig, both the entry's import and a `require('fakews')` inside a JS
  package in `node_modules` resolve to `index.ts`, also when a `fakews` package is
  installed (it prints `WebSocket.OPEN=1`, not the installed package's 42).
- `--define` (prunes, but cannot reach this module): a package whose `index.js` assigns
  `module.exports = require(...)` by `process.env.FAKEWS_NATIVE` compiles only the branch
  the defined value selects; a build with `=1` succeeds while an unselected branch that
  fails to compile is in the file. But a branch that requires `index.ts` fails with SC1010
  (a JS module cannot require a `.ts` module), so `ws/index.js` could select this
  implementation only if it shipped as JavaScript plus `.d.ts`, which was not tried.

Proposal: native builds add `"ws": ["<root>/native/ws/index.ts"]` to `paths` in the
tsconfig of each scriptc entry (the daemon and the CLI); Node builds use their own
tsconfigs and keep npm `ws`. No patch to `ws` or to Paseo's imports is needed. Checked
without building Paseo: `tsc -p` of `packages/client` and `packages/server` with that
mapping (scratch tsconfigs extending Paseo's, `rootDir` and `typeRoots` widened) reports no
errors, and `--listFiles` shows `native/ws/*.ts` in place of `ws`.

## Unverified

- A scriptc build of the Paseo daemon or CLI with the `paths` mapping. Only Paseo's client
  transport module is compiled natively here (the `paseo-transport` scenario).
- `relationship-remote.ts`'s `'upgrade'` and `'unexpected-response'` handling, and the relay
  transport, against real Hub and relay servers.
- Windows; `wss://` through a proxy; IPv6 hosts; peers that split the handshake response
  across many packets (the parser accumulates, but no test splits it).
- Throughput and memory under load: the masking loop and `Buffer.concat` of fragments are
  not measured.

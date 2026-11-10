# native/express

A small express-compatible router on `node:http` for native scriptc builds of the Paseo daemon.
It covers exactly the express surface Paseo's server uses ([INVENTORY.md](INVENTORY.md)); Node
builds keep real express.

express 4 does not run under scriptc: it swaps the prototypes of every request and response
with `Object.setPrototypeOf`, reads `http.IncomingMessage.prototype` as a value, and builds its
router by assigning computed keys onto a prototype, and depd, debug, body-parser and
http-errors add more of the same. This module wraps the node:http objects instead. A
`Request` and a `Response` are classes holding the originals in `raw`; nothing touches a
prototype. Paseo's four express files compile against this module and against real express
from one source; the only module-specific member they reach is `raw`, through
`packages/server/src/server/express-node-http.ts` ([Using it from Paseo](#using-it-from-paseo)).

```
$ ./test.sh
== typecheck
== native build
== real express twin
== fixtures
== compare
ok   health-get 200
...
ok   module-native drains a 64 MiB body: status 413, RSS growth 0.0 MiB
110 cases, 0 failures
```

## Implemented surface

`express.ts` exports `default express` (a function merged with a type-only namespace, so
`express.Request`, `express.Response`, `express.Application`, `express.RequestHandler` and
`express.NextFunction` resolve as with @types/express), plus the classes `Request`,
`Response`, `HttpError` and the types `Application`, `RequestHandler`, `NextFunction`, `Query`,
`TrustProxySetting`. `package.json` marks the directory as ESM so that `import express from
"express"` in Paseo's ESM sources gets the default export when a tsconfig `paths` entry maps
`express` here.

- `express()` returns the application, which is the node:http request listener, as in express:
  `http.createServer(app)`. Its methods are assigned onto that function.
- `app.set("trust proxy", value)`: `value` is `unknown`, as express takes any value; `true` or
  an array of strings is accepted, anything else throws a `TypeError`. Entries take
  proxy-addr's names (`loopback`, `linklocal`, `uniquelocal`), IPv4 and IPv6 addresses, CIDR
  prefixes and IPv4 netmasks. Invalid entries throw express's messages (`invalid IP address:
  x`, `invalid range on address: x`).
- `app.use(handler)`, `app.use("/prefix", handler)`, `app.get|post|delete(path, ...handlers)`.
  Literal paths only, matched like path-to-regexp 0.1: case-insensitive, optional trailing
  slash, `GET` routes answer `HEAD`. A prefix mount strips the prefix from `req.url` and
  `req.path`, keeps `req.originalUrl`, and matches at a `/` boundary.
- Synchronous throws, `next(err)` and rejected handler promises go to the final handler.
- Final handler (finalhandler 1.3 in production mode): 404 `Cannot GET /path` with the path
  percent-encoded and HTML-escaped, error status from `HttpError.status` or a 4xx/5xx
  `res.statusCode`, else 500, body the status text only, `Content-Security-Policy:
  default-src 'none'` and `X-Content-Type-Options: nosniff`, socket destroyed when headers
  were already sent. It waits for the request body to finish, draining it.
- `Request`: `raw`, `method`, `url`, `originalUrl`, `path`, `headers`, `socket`, `header(name)`
  (case-insensitive, `Referer`/`Referrer`), `protocol` (X-Forwarded-Proto's first entry when
  the peer is trusted, else `http`), `query`, `body`, and `pipe(clientRequest, { end: true })`,
  which pipes `raw` with the one-argument form scriptc lowers.
- `req.query`: qs-style flat parsing. Repeated keys become arrays, `+` is a space, malformed
  escapes stay as written, `__proto__` is dropped, keys such as `toString` are ordinary keys,
  at most 1000 parameters.
- `Response` extends `stream.Writable` over `raw`: `readable.pipe(res)` from a file stream
  works natively, each chunk goes to `raw.write`, and `end()` reaches `raw.end()` through
  `_final`, one tick later. `destroyed` turns true and `close` is emitted when `raw` closes.
  Also `raw`, `status()`, `setHeader()`, `writeHead()`, `json()`, `send(string)`,
  `headersSent`, `statusCode`. An IncomingMessage (an upstream response) cannot be piped into
  it natively: pipe it into `res.raw`.
  `send` sets express's Content-Type default and `charset=utf-8`, Content-Length, a weak ETag
  identical to express's, answers 304 to a matching conditional GET, and strips the body for
  204, 205, 304 and HEAD.
- `express.json()`: `application/json` bodies only (other types pass through with
  `req.body = {}`), UTF-8 only, identity encoding only, strict (top level must be an object or
  an array), BOM stripped, empty body `{}`, 100kb limit. A body is parsed once even when two
  parsers run (`bodyRead`).
- `express.static(root)`: GET and HEAD, `index.html` for `dir/`, 301 from `dir` to `dir/`
  (leading slashes collapsed, query kept), mime 1.6 types for common web extensions with
  `charset=UTF-8` on text, JavaScript and JSON, `Cache-Control: public, max-age=0`,
  `Last-Modified`, the same weak ETag as send 0.19, 304 on `If-None-Match` and
  `If-Modified-Since` (not with `Cache-Control: no-cache`). Everything it does not serve falls
  through to `next()`, as serve-static does with `fallthrough: true`.

Left out because Paseo does not use them: `:param`, wildcard and regex routes, routers,
`app.all`, `app.listen`, settings other than `trust proxy`, error middleware with four
arguments, `next("route")`, `res.redirect`, `res.sendFile`, `res.set`, `res.type`, cookies,
`req.ip`, `req.hostname`, `req.params`, `express.urlencoded`, `express.raw`, json options,
static options.

## Security

- Static paths are decoded once; a malformed escape, a NUL byte, a `..` segment (with `/` or
  `\`), and any segment starting with `.` fall through to 404. The root is resolved, the file
  is joined under it, and both are passed through `realpath`; a file whose real path is not
  inside the real root is not served, nor is anything but a regular file. Tested:
  `traversal-*`, `static-dotfile`, `static-dot-directory`, `static-symlink-outside`, plus a
  check that no module response contains the outside file.
- `express.json()` rejects a declared `Content-Length` over the limit before reading and stops
  buffering once received bytes pass it, then drains the rest. Tested: `terminal-too-large`,
  `terminal-too-large-chunked`, `terminal-over-limit-by-one`, `terminal-at-limit`, and a 64 MiB
  chunked body whose RSS growth the native binary must keep under 16 MiB (measured: 0.0 MiB;
  the Node processes are not held to it because unreferenced Buffers stay resident until V8
  collects them, real express included).
- Header names and values go to node:http unchanged, which rejects CR, LF and other invalid
  characters: `setHeader` throws `ERR_INVALID_CHAR` for a value and `ERR_INVALID_HTTP_TOKEN`
  for a name, natively as under Node (`header-injection`). Paths echoed in 404 pages and
  redirect `Location` headers are percent-encoded with encodeurl's rules, and HTML-escaped in
  bodies (`notfound-html`, `notfound-encoded`).
- Error responses carry the status text only, never the error message or stack, in every
  `NODE_ENV` (`throw`, `next-error`, `auth-throws`, plus a check that no module response
  contains a thrown message).

## Deliberate differences from express

`test.sh` reads this table: a difference from express fails the run unless its case and field
are listed here, and a listed row that no longer differs fails too. `*` matches any case or any
field. The Node and native runs of the module must agree on every field.

<!-- intentional-differences:start -->
| Case | Field | Express | This module | Why |
| --- | --- | --- | --- | --- |
| `*` | `header:x-powered-by` | `Express` | absent | Advertises the framework and nothing reads it. |
| `*` | `header:accept-ranges` | `bytes` | absent | Range requests are not implemented, so they are not advertised. |
| `static-range` | `*` | 206, `Content-Range` | 200, full file | Range requests are not implemented; Paseo's web UI does not go through `express.static`. |
| `static-dot-directory` | `*` | 200, serves `.dir/file.txt` | 404 | send ignores only a dotfile in the last segment; any dot segment (`.git/config`) is refused here. |
| `static-symlink-outside` | `*` | 200, serves the target | 404 | A symlink resolving outside the static root is not served. |
| `reject` | `*` | no response (express 4 leaves the rejection unhandled) | 500 | A rejected handler promise goes to `next(err)`, as in express 5. |
| `terminal-gzip` | `*` | 204, body inflated | 415 | Only identity `Content-Encoding` is accepted; no Paseo client compresses request bodies. |
| `echo-query-nested` | `*` | `{"o":{"k":"v"},"arr":["1"]}` | `{"o[k]":"v","arr[]":"1"}` | Bracket syntax is not expanded; Paseo reads only flat `token` and `callerAgentId`. |
<!-- intentional-differences:end -->

Differences the probe does not exercise:

- express logs every error's stack to stderr (`console.error` in `app.handle`'s final handler)
  unless `NODE_ENV=test`; this module logs nothing. With `NODE_ENV` unset express also puts
  the stack in the 500 body; the probe runs express with `NODE_ENV=production`.
- Only `HttpError` carries a status into the final handler; express also honors `status` and
  `statusCode` on any thrown object, and copies its `headers`.
- JSON charsets other than UTF-8 (`utf-16`, `utf-32`) are 415; body-parser decodes any `utf-*`.
- An absolute-form request target (`GET http://host/path`) is matched as the literal string;
  express matches its pathname.
- `OPTIONS` to a path with routes but no handler for it gets 404; express answers 200 with an
  `Allow` list. Paseo's CORS middleware answers every `OPTIONS` before routing.
- The connection protocol is always `http`: the module is for node:http servers, and Paseo's
  daemon serves plain HTTP.
- `trust proxy` accepts only addresses `net.isIP` accepts; ipaddr.js also takes forms such as
  `0x7f.1`.
- The static handler serves only regular files; send also streams FIFOs and devices.
- `res.end(body)` with no headers sent yet goes out chunked (the Writable writes the body, then
  ends); express sends `Content-Length` (`probes/end-body.ts`, under Node and natively).
  Paseo calls `end(body)` only after `writeHead`, where both are chunked.
- `res.end(callback)` and `res.on("finish")` follow the Writable, not the node:http response.

## scriptc limits and workarounds

scriptc 0.4.10, `--node-islands=off`. Each was hit while building `tests/server.ts` or a probe.

| Limit (diagnostic) | Workaround |
| --- | --- |
| `http.createServer({ IncomingMessage, ServerResponse })` has no lowering (`SC2020`), so subclassing the node:http classes is out | Wrapper classes with `raw`. |
| A file stream does not pipe into a `ServerResponse` (`SC2020`); an `IncomingMessage` pipes only into a `ServerResponse`, `ClientRequest` or `Socket` (`SC2020`, "pipe into 'Res' destinations"); `pipe(dest, { end })` with two arguments (`SC2020`) | `Response` extends `Writable`, which a file stream pipes into; an upstream response is piped into `res.raw`; `Request.pipe` calls the one-argument `raw.pipe(clientRequest)`. |
| A `Writable` subclass cannot override `end` ("overriding the stream member 'end'", `SC1090`) | `_write` and `_final` only. |
| The result of `incoming.pipe(dest)` cannot be used (`SC1090`) | Call it as a statement, return `dest`. |
| `"raw" in res` on a `Writable` subclass (`SC1090`) | Paseo's adapter checks `process.argv[0] === "scriptc"`. |
| An object whose type is a class (`Request`) is not accepted where `IncomingMessage` or `Pick<IncomingMessage, ...>` is declared (`SC1090`) | Pass `raw`; a plain interface parameter accepts both classes. |
| `res.write()`'s result cannot be used and `write(chunk, callback)` has no lowering (`SC1090`, `SC2020`); `res.writableLength` has no lowering | None: there is no backpressure into a native response. `probes/streams.ts` measured a 20 MB file sent to a reader paused for 1 s: RSS +21 MiB native, +20 MiB under Node with the same unthrottled writes. |
| `end(body, "utf8")` is read as an end callback (`SC1090`) | `end(body)`. |
| `writeHead(status, headers)` with `headers: OutgoingHttpHeaders \| undefined` (`SC2020`) | Branch on `undefined`. |
| `res.on(event, ...)` with a non-literal event name (`SC2020`) | Literal `"close"` calls. |
| `IncomingMessage.readableEnded` has no lowering (`SC2020`) | `complete` and `destroyed`. |
| `fs.stat`/`fs.realpath` callbacks deliver `Stats` as `unknown` (`SC1100`) | `node:fs/promises`. |
| `app.use(path, handler)` needs a `string \| function` parameter | Compiled as written: a `typeof` check on that union lowers. |
| The application must be callable for `http.createServer(app)` | A `const` arrow function with its methods assigned as expando properties compiles and runs. |
| `express.static` is not a valid namespace member name (`static` is reserved) | `express.json = json; express.static = serveStatic;` expando assignments on the function, beside a namespace that holds only types (`probes/features2.ts`). |

Under Node only (no scriptc involvement): a plain-object lookup table returns
`Object.prototype` members for keys such as `toString` or `constructor`, so the query
accumulator, the mime table and the named trust ranges are Maps (`echo-query`,
`static-prototype-extension`, the `toString` trust entry).

## Verification

`./test.sh` (about 5 s with a warm scriptc cache) runs, from the repository root found by
walking up to `.gitmodules`:

1. `tsc -p .` over `express.ts`, `tests/` and `probes/`.
2. `scriptc build tests/server.ts --optimization dev --node-islands=off` into
   `.scratch/nativeexpress/server-native` (an ELF linking only libc; no warnings).
3. `sed` generates `.scratch/nativeexpress/gen/server-express.ts` from `tests/server.ts`, the
   same routes on real express; the only rule maps `res.raw` to `res` (the import aside), and
   the script fails if `.raw` survives.
4. Fixtures under `.scratch/nativeexpress/fixtures` with fixed mtimes.
5. `tests/compare.ts` starts real express (`NODE_ENV=production`), the module under Node, and
   the native binary, all on 127.0.0.1 port 0, sends 110 requests to each with a 3 s timeout,
   and compares status, every header except `Date`, `Connection` and `Keep-Alive`, and the
   body. It also compares the `trust proxy` results for ten entries (eight invalid), runs the security
   checks above, and the 64 MiB drain.

The routes in `tests/server.ts` follow Paseo's handlers: service proxy
(`req.pipe(proxyReq, { end: true })` to an upstream and `proxyRes.pipe(res.raw)` back), host
allowlist, CORS with `OPTIONS` 204, the terminal-activity route with `express.json()` and an
async handler, a web-UI middleware with `send` and `stream.pipe(res)`, async bearer auth with
`next(error)`, global `express.json()`, `/public` static, health, download with
`req.query.token`, and the three MCP routes with `callerAgentId` as string or array. Trust
cases connect from 127.0.0.1 through 127.0.0.4 to check a netmask entry and an IPv4-mapped
IPv6 entry.

Probes, each run by hand:

- `probes/mcp.ts`: `StreamableHTTPServerTransport.handleRequest(req.raw, res.raw, req.body)`
  behind this module answers an MCP `initialize` with `200 text/event-stream` and the
  server's `serverInfo`, under Node (`node --import tsx probes/mcp.ts`).
- `probes/streams.ts <file>`: the RSS measurement in the limits table.
- `probes/features2.ts`: the expando-plus-namespace export compiles natively.
- `probes/end-body.ts`: the `res.end(body)` framing difference.

Paseo's own files against this module: `.scratch/wire-express/probe/` holds a probe that
mounts bootstrap.ts's HTTP layer in bootstrap's order with Paseo's `service-proxy.ts`,
`web-ui.ts`, `auth.ts`, `hostnames.ts`, the download token store and the MCP SDK transport,
and a driver that sends 37 requests to it under Node with real express and as a native
binary. Every status, header (except `Date`, `Connection`, `Keep-Alive`, and the
`X-Powered-By` and `Accept-Ranges` rows above) and body matched, including an MCP
`initialize` round trip natively. What the probe needed outside this module is listed in
its `run.sh`.

Not verified: the module inside a native Paseo daemon build (bootstrap.ts's program does not
build yet); a slow client against a large static file or download natively beyond the RSS
probe; upgrade requests (they bypass express in Paseo); IPv6 clients (test servers bind
127.0.0.1 only).

## Using it from Paseo

Native builds map `express` to this file with a tsconfig `paths` entry; Node builds keep
real express. Paseo's sources are the same for both:

- Types keep their names (`express.Request`, `express.Response`, `express.Application`,
  `express.RequestHandler`, `RequestHandler`, `Response`, `Parameters<RequestHandler>[0]`).
- `createHTTPServer(app)`, `app.set("trust proxy", unknownValue)`, `stream.pipe(res)` from a
  file stream, `req.pipe(proxyReq, { end: true })`, `res.on("close")`, `res.destroyed`
  compile and behave as with express.
- Where Paseo needs the node:http objects themselves (the service proxy's
  `buildForwardedHeaders` and `proxyRes.pipe(...)`, and the MCP transport),
  `packages/server/src/server/express-node-http.ts` gives them: `nodeRequest(req)` and
  `nodeResponse(res)` return their argument under Node and `raw` natively. The service proxy
  pipes the upstream response with the one-argument `pipe`, whose `end` default is the
  `{ end: true }` it passed before.

## Files

- `express.ts`: the module.
- `package.json`: `"type": "module"`, nothing else.
- `INVENTORY.md`: the express surface Paseo uses, with file:line references.
- `test.sh`: typecheck, native build, express twin, fixtures, comparison.
- `tests/server.ts`: the probe server; `tests/compare.ts`: the comparison driver.
- `probes/`: the scriptc probes named above.
- `node_modules`: symlink to `work/paseo/node_modules` (gitignored), which provides real
  express, tsx, the MCP SDK and @types/node.

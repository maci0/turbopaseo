# Express surface used by Paseo

Measured on `work/paseo/packages/server/src` (express 4.22.1, @types/express 4.17.25) with
`rg -n 'from "express"' work/paseo/packages/server/src -g '!*.test.ts'`. Four files import
express; no other package in `work/paseo/packages` does. Line numbers are upstream v0.15.3
(`paseo/`); the work tree has since moved some by a few lines. Paths are relative to
`work/paseo/packages/server/src/server/`.

## Imports and types

| Use | Where |
| --- | --- |
| `import express from "express"` (value) | `bootstrap.ts:12`, `service-proxy.ts:7` |
| `import type { RequestHandler } from "express"` | `service-proxy.ts:7`, `auth.ts:3` |
| `import type { RequestHandler, Response } from "express"` | `web-ui.ts:3` |
| `express.RequestHandler` | `bootstrap.ts:316`, `bootstrap.ts:1725` |
| `express.Application` | `bootstrap.ts:551` |
| `express.Request`, `express.Response` | `bootstrap.ts:869`, `bootstrap.ts:1644-1645` |
| `Parameters<RequestHandler>[0]` and `[1]` | `web-ui.ts:186-187`, `web-ui.ts:234`, `web-ui.ts:271`, `service-proxy.ts:325-326` |

## Application

| Member | Where | Notes |
| --- | --- | --- |
| `express()` | `bootstrap.ts:716`, `service-proxy.ts:943` | |
| `app.set("trust proxy", true \| string[])` | `bootstrap.ts:717`, `bootstrap.ts:719`, `service-proxy.ts:944` | Values: `config.trustedProxies ?? ["loopback"]`; a config-store change handler passes `unknown` (`daemon-config-store.ts:75`) at `bootstrap.ts:719`; `true` for the standalone service proxy. The setting is user config (`persisted-config.ts:249`, `PASEO_TRUSTED_PROXIES`), so names, IPs, CIDRs and netmasks can all appear. |
| `app.use(handler)` | `bootstrap.ts:552`, `:777`, `:782`, `:813`, `:843`, `:849`, `service-proxy.ts:945-946` | Root mounts only. |
| `app.use("/public", handler)` | `bootstrap.ts:852` | The only prefix mount. |
| `app.post(path, express.json(), handler)` | `bootstrap.ts:829-833` | The only route with two handlers. |
| `app.get(path, handler)` | `bootstrap.ts:855`, `:859`, `:924`, `:1730` | |
| `app.post(path, handler)`, `app.delete(path, handler)` | `bootstrap.ts:1729`, `:1731` | |
| `createHTTPServer(app)` (app as request listener) | `bootstrap.ts:928`, `service-proxy.ts:949` | The server also gets `upgrade` listeners (`bootstrap.ts:934`, `service-proxy.ts:950`); those take raw node:http objects and never touch express. |

Route paths are all literal: `/api/terminal-activity`, `/api/health`, `/api/status`,
`/api/files/download`, `/mcp/agents` (`bootstrap.ts:1610`). No `:param`, no wildcard, no regex,
no `app.route()`, no `express.Router()`, no `app.listen()`, no `app.all()`.

No error middleware (4 arguments) exists: `rg -n '\(err, req, res, next\)|ErrorRequestHandler'`
finds nothing. Errors reach express's final handler from `next(error)` (`auth.ts:109`), a
synchronous throw, or body-parser.

## `express.json()` and `express.static()`

| Use | Where | Options |
| --- | --- | --- |
| `express.json()` | `bootstrap.ts:831` (route), `bootstrap.ts:849` (global) | none: 100kb limit, strict, `application/json` only, inflate on |
| `express.static(staticDir)` | `bootstrap.ts:852` | none: index `index.html`, redirect on, dotfiles default, etag and Last-Modified on, `max-age=0`, ranges on, fallthrough on |

`staticDir` is `config.staticDir` (`bootstrap.ts:698`), default `"public"` (`config.ts:636`).
The web UI does not use `express.static`; `web-ui.ts` streams files itself, so ranges and ETags
are not needed for it.

## Request

| Member | Where |
| --- | --- |
| `req.method` | `bootstrap.ts:821`, `:1668`, `:1681`; `auth.ts:83`, `:100`; `web-ui.ts:163`, `:210`; `service-proxy.ts:336` |
| `req.headers.host`, `.origin`, `["accept-encoding"]` | `bootstrap.ts:783`, `:814`; `web-ui.ts:200`, `:274`; `service-proxy.ts:766` |
| `req.header("authorization")`, `req.header("mcp-session-id")` | `bootstrap.ts:1659`, `:1670-1671`; `auth.ts:90` |
| `req.query.token` (string check, `.trim()`) | `bootstrap.ts:871-872` |
| `req.query.callerAgentId` (string or first array element) | `bootstrap.ts:1692-1698` |
| `req.body` | `bootstrap.ts:323` (zod `safeParse`), `:1672` (`describeMcpDebugPayload(value: unknown)`), `:1708` |
| `req.path` | `auth.ts:83`, `:91`, `:99`; `web-ui.ts:168`, `:178` |
| `req.originalUrl` | `bootstrap.ts:1669`; `service-proxy.ts:335` |
| `req.protocol` (reads `trust proxy`, X-Forwarded-Proto) | `web-ui.ts:275`; `service-proxy.ts:330` |
| `req.socket.remoteAddress` | `bootstrap.ts:318`; `service-proxy.ts:285` (through `buildForwardedHeaders`) |
| `req` passed where `IncomingMessage` is declared | `service-proxy.ts:330` (`buildForwardedHeaders` reads `headers`, `socket`), `service-proxy.ts:355` (`req.pipe(proxyReq, { end: true })`), `bootstrap.ts:1706` (MCP transport) |

Not used anywhere: `req.ip`, `req.ips`, `req.hostname`, `req.secure`, `req.params`, `req.cookies`,
`req.get()`, `req.is()`, `req.accepts()`, `req.baseUrl`, `req.fresh`.

## Response

| Member | Where |
| --- | --- |
| `res.status(code)` chained with `.json()`, `.end()`, `.send()` | throughout, e.g. `bootstrap.ts:319`, `:347`; `web-ui.ts:174`, `:240`; `service-proxy.ts:772`, `:947` |
| `res.json(value)` | `bootstrap.ts:856`, `:860` and every `status().json()` |
| `res.send(string)` | `web-ui.ts:240` (HTML), `service-proxy.ts:772`, `:947` (`"404 Not Found"`) |
| `res.end()`, `res.end(string)` | `bootstrap.ts:910`; `web-ui.ts:225`; `service-proxy.ts:352` |
| `res.setHeader(name, value)` | `bootstrap.ts:816-819`, `:898-900`; `web-ui.ts:132-138`, `:203-206` |
| `res.writeHead(status, headers)` | `service-proxy.ts:341`, `:351` |
| `res.headersSent` | `bootstrap.ts:907`, `:916`, `:1712`; `web-ui.ts:222`; `service-proxy.ts:350` |
| `res.destroyed` | `bootstrap.ts:890` |
| `res.once("close", fn)`, `res.on("close", fn)` | `bootstrap.ts:904`, `:1700` |
| a stream piped into `res` | `bootstrap.ts:913` (file download), `web-ui.ts:228` (UI asset), `service-proxy.ts:342` (`proxyRes.pipe(res, { end: true })`) |
| `res` passed where `ServerResponse` is declared | `bootstrap.ts:1707` (MCP transport) |

Not used anywhere: `res.set()`, `res.get()`, `res.type()`, `res.redirect()`, `res.sendFile()`,
`res.cookie()`, `res.locals`, `res.sendStatus()`, `res.format()`, `res.download()`.

## What the MCP transport reads

`bootstrap.ts:1705-1709` calls
`StreamableHTTPServerTransport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, req.body)`
(`@modelcontextprotocol/sdk` 1.29.0, `dist/esm/server/streamableHttp.js`). It hands both
objects to `getRequestListener` from `@hono/node-server` (installed: 1.19.14), which needs the
real node:http objects:

- request: `method`, `url`, `headers`, `rawHeaders`, `headers.host`, `socket.encrypted`,
  `complete`, `readableEnded`, `readableDidRead`, `destroyed`, `errored`, `on`/`off`/`resume`
  for body draining, `instanceof Http2ServerRequest`, and `req.auth` (unset in Paseo). The body
  itself is not read: `parsedBody` is passed in, which is why `express.json()` must have run.
- response: `writeHead`, `write`, `end`, `flushHeaders`, `headersSent`, `writable`,
  `writableFinished`, `hasHeader`, `destroy`, `on("close")`, and the internal fields
  `_contentLength`, `_hasBody`, `_removedContLen`, `useChunkedEncodingByDefault`.

Paseo passes `nodeRequest(req)`, `nodeResponse(res)` and `req.body`
(`express-node-http.ts`): the express objects under Node, `req.raw` and `res.raw` natively.
`probes/mcp.ts` checks the `raw` form under Node; the Paseo probe in
`.scratch/wire-express/probe/` runs an `initialize` round trip natively.

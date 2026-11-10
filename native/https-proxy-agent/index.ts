// Native stand-in for `https-proxy-agent`, selected with a tsconfig `paths` entry. The
// package's agent extends http.Agent through agent-base, which scriptc refuses, and the
// native `ws` stand-in throws for any `agent` option, so a native build cannot tunnel
// WebSockets through an HTTPS proxy. Constructing the agent throws instead.
import type { Agent } from "node:http";

class NativeHttpsProxyAgent {
  constructor(proxy: string | URL) {
    throw new Error(
      `WebSocket connections through a proxy (${String(proxy)}) are not supported in the native build`,
    );
  }
}

// Typed as the package's constructor so callers that return an http.Agent type check.
export const HttpsProxyAgent = NativeHttpsProxyAgent as unknown as new (
  proxy: string | URL,
) => Agent;

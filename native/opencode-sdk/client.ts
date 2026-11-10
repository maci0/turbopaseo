// `@opencode-ai/sdk/v2/client` in the native daemon: the calls Paseo makes, with the
// generated client's request and response rules. The generated client (hey-api) builds
// every request from runtime parameter tables and spreads, and constructs a default client
// at module load, which scriptc cannot compile (SC1101). Types are the SDK's own generated
// declarations, copied into ./types by sync-types.sh.
//
// Request rules, from dist/v2/gen/client/*.gen.js, core/*.gen.js and client.js (1.14.46):
// - URL: baseUrl + path, path parameters through encodeURIComponent, then query parameters
//   in the caller's order, `name=encodeURIComponent(value)`, undefined values left out.
// - Body: JSON of the body fields, sent with Content-Type application/json only when at
//   least one body field is defined (the generated client drops an empty body slot).
// - Headers: `x-opencode-directory: encodeURIComponent(config.directory)` on every request;
//   on GET and HEAD it is removed and, when the query has no `directory`, the configured
//   directory is added with URL.searchParams.set.
// - Result: `{ data, request, response }` on a 2xx (JSON body, `{}` when empty or 204);
//   `{ error, request, response }` otherwise, the error being the JSON body, else its text,
//   else `{}`; `{ error, request, response: undefined }` when fetch throws.
// - A text/html response throws, as the SDK's response interceptor does.
import type {
  AppAgentsData,
  AppAgentsResponses,
  CommandListData,
  CommandListResponses,
  ExperimentalSessionListData,
  ExperimentalSessionListResponses,
  GlobalEvent,
  McpAddData,
  McpAddResponses,
  PermissionListData,
  PermissionListResponses,
  PermissionReplyData,
  PermissionReplyResponses,
  ProviderListData,
  ProviderListResponses,
  PtyListData,
  PtyListResponses,
  QuestionListData,
  QuestionListResponses,
  QuestionRejectData,
  QuestionRejectResponses,
  QuestionReplyData,
  QuestionReplyResponses,
  SessionAbortData,
  SessionCommandData,
  SessionCommandResponses,
  SessionAbortResponses,
  SessionChildrenData,
  SessionChildrenResponses,
  SessionCreateData,
  SessionCreateResponses,
  SessionDeleteData,
  SessionDeleteResponses,
  SessionGetData,
  SessionGetResponses,
  SessionMessagesData,
  SessionMessagesResponses,
  SessionPromptAsyncData,
  SessionPromptAsyncResponses,
  SessionRevertData,
  SessionRevertResponses,
  SessionStatusData,
  SessionSummarizeData,
  SessionSummarizeResponses,
  SessionStatusResponses,
  SessionUpdateData,
  SessionUpdateResponses,
} from "./types/types.gen.js";

export type * from "./types/types.gen.js";

// The generated methods' flattened parameters: path fields as declared, query and body fields
// all optional. A slot the SDK declares `never` contributes no fields.
type Slot<T> = [NonNullable<T>] extends [never] ? unknown : NonNullable<T>;
type OptionalSlot<T> = [NonNullable<T>] extends [never] ? unknown : Partial<NonNullable<T>>;
type Flat<D> = (D extends { path?: infer P } ? Slot<P> : unknown) &
  (D extends { query?: infer Q } ? OptionalSlot<Q> : unknown) &
  (D extends { body?: infer B } ? OptionalSlot<B> : unknown);
// The 200 body type; a 204-only endpoint's data is unknown, because the generated client
// returns {} for an empty body whatever the declared type is.
type Ok<R> = R extends { 200: infer T } ? T : unknown;

// One record, not the SDK's `{ data } | { error }` union: scriptc cannot tell the two arms apart
// (SC2003). Exactly one of data and error is set. The error is the decoded error body, typed
// unknown: the SDK's per-endpoint error unions have no discriminant scriptc can cast to.
export interface RequestResult<TData> {
  data: TData | undefined;
  error: unknown;
  request: Request;
  response: Response | undefined;
}

interface RawResult {
  data: unknown;
  error: unknown;
  request: Request;
  response: Response | undefined;
}

// The cast to the endpoint's data type happens at each call site: scriptc cannot cast an
// untyped value to a type parameter.
function typed<T>(raw: RawResult, data: T | undefined): RequestResult<T> {
  return { data, error: raw.error, request: raw.request, response: raw.response };
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface OpencodeClientConfig {
  baseUrl?: string;
  directory?: string;
  fetch?: (request: Request) => Promise<Response>;
}

export interface ServerSentEventsOptions extends RequestOptions {
  onSseError?: (error: unknown) => void;
  sseDefaultRetryDelay?: number;
  sseMaxRetryAttempts?: number;
  sseMaxRetryDelay?: number;
}

type QueryValue = string | number | boolean | undefined;

const DEFAULT_SSE_RETRY_DELAY_MS = 3000;
const DEFAULT_SSE_MAX_RETRY_DELAY_MS = 30000;
const UNSUPPORTED_SERVER_MESSAGE =
  "Request is not supported by this version of OpenCode Server (Server responded with text/html)";

function queryString(entries: Array<[string, QueryValue]>): string {
  const parts: string[] = [];
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    parts.push(`${name}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

/**
 * The generated client's getParseAs, reduced to what OpenCode sends: JSON, text, and the raw
 * body when there is no Content-Type. Binary types (blob, formData) are read as the raw body
 * too; no endpoint Paseo calls returns one.
 */
function parseKind(contentType: string | null): "json" | "text" | "stream" {
  if (!contentType) return "stream";
  const clean = contentType.split(";")[0]?.trim() ?? "";
  if (clean.startsWith("application/json") || clean.endsWith("+json")) return "json";
  if (clean.startsWith("text/")) return "text";
  if (clean === "multipart/form-data" || /^(application|audio|image|video)\//.test(clean)) return "stream";
  return "json";
}

async function readError(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text === "" ? {} : text;
  }
}

class Transport {
  private readonly baseUrl: string;
  private readonly directory: string | undefined;
  private readonly fetchImpl: (request: Request) => Promise<Response>;

  constructor(config: OpencodeClientConfig) {
    this.baseUrl = config.baseUrl ?? "";
    this.directory = config.directory;
    this.fetchImpl = config.fetch ?? ((request) => fetch(request));
  }

  buildRequest(
    method: string,
    path: string,
    query: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    extraHeaders: Array<[string, string]>,
  ): Request {
    let url = this.baseUrl + path + (query ? `?${query}` : "");
    const headers = new Headers();
    for (const [name, value] of extraHeaders) headers.set(name, value);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.directory) {
      if (method === "GET" || method === "HEAD") {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("directory")) parsed.searchParams.set("directory", this.directory);
        url = parsed.toString();
      } else {
        headers.set("x-opencode-directory", encodeURIComponent(this.directory));
      }
    }
    return new Request(url, {
      method,
      headers,
      redirect: "follow",
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async send(
    method: string,
    path: string,
    query: string,
    body: string | undefined,
    options: RequestOptions | undefined,
  ): Promise<RawResult> {
    const request = this.buildRequest(method, path, query, body, options?.signal, []);
    let response: Response;
    try {
      response = await this.fetchImpl(request);
    } catch (error) {
      return { data: undefined, error: error || {}, request, response: undefined };
    }
    if (response.headers.get("content-type") === "text/html") {
      throw new Error(UNSUPPORTED_SERVER_MESSAGE);
    }
    if (response.ok) {
      const kind = parseKind(response.headers.get("Content-Type"));
      const empty = response.status === 204 || response.headers.get("Content-Length") === "0";
      let data: unknown;
      if (kind === "stream") data = response.body;
      else if (kind === "text") data = await response.text();
      else if (empty) data = {};
      else {
        const text = await response.text();
        data = text ? (JSON.parse(text) as unknown) : {};
      }
      return { data, error: undefined, request, response };
    }
    const error = await readError(response);
    return { data: undefined, error: error || {}, request, response };
  }

  /** The generated client's server-sent events loop (core/serverSentEvents.gen.js). */
  async *events<T>(path: string, options: ServerSentEventsOptions): AsyncGenerator<T, void, unknown> {
    let lastEventId: string | undefined;
    let retryDelay = options.sseDefaultRetryDelay ?? DEFAULT_SSE_RETRY_DELAY_MS;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted) break;
      attempt++;
      try {
        const extra: Array<[string, string]> =
          lastEventId !== undefined ? [["Last-Event-ID", lastEventId]] : [];
        const request = this.buildRequest("GET", path, "", undefined, signal, extra);
        const response = await this.fetchImpl(request);
        if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error("No body in SSE response");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const abortHandler = (): void => {
          void reader.cancel().catch(() => {
            // A cancel racing fetch's own abort teardown rejects; nothing reads it.
          });
        };
        signal.addEventListener("abort", abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const dataLines: string[] = [];
              for (const line of chunk.split("\n")) {
                if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""));
                else if (line.startsWith("id:")) lastEventId = line.replace(/^id:\s*/, "");
                else if (line.startsWith("retry:")) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ""), 10);
                  if (!Number.isNaN(parsed)) retryDelay = parsed;
                }
              }
              if (dataLines.length === 0) continue;
              const raw = dataLines.join("\n");
              let data: unknown;
              try {
                data = JSON.parse(raw) as unknown;
              } catch {
                data = raw;
              }
              yield data as T;
            }
          }
        } finally {
          signal.removeEventListener("abort", abortHandler);
          reader.releaseLock();
        }
        break;
      } catch (error) {
        options.onSseError?.(error);
        if (options.sseMaxRetryAttempts !== undefined && attempt >= options.sseMaxRetryAttempts) break;
        const backoff = Math.min(
          retryDelay * 2 ** (attempt - 1),
          options.sseMaxRetryDelay ?? DEFAULT_SSE_MAX_RETRY_DELAY_MS,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
}

function jsonBody(body: object): string | undefined {
  const text = JSON.stringify(body);
  return text === "{}" ? undefined : text;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

class SessionApi {
  constructor(private readonly t: Transport) {}

  async abort(p: Flat<SessionAbortData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionAbortResponses>>> {
    const r = await this.t.send("POST", `/session/${seg(p.sessionID)}/abort`, queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<SessionAbortResponses> | undefined);
  }

  async messages(p: Flat<SessionMessagesData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionMessagesResponses>>> {
    const r = await this.t.send("GET", `/session/${seg(p.sessionID)}/message`, queryString([["directory", p.directory], ["workspace", p.workspace], ["limit", p.limit], ["before", p.before]]), undefined, o);
    return typed(r, r.data as Ok<SessionMessagesResponses> | undefined);
  }

  async create(p: Flat<SessionCreateData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionCreateResponses>>> {
    const r = await this.t.send("POST", "/session", queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ parentID: p.parentID, title: p.title, agent: p.agent, model: p.model, permission: p.permission, workspaceID: p.workspaceID }), o);
    return typed(r, r.data as Ok<SessionCreateResponses> | undefined);
  }

  async update(p: Flat<SessionUpdateData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionUpdateResponses>>> {
    const r = await this.t.send("PATCH", `/session/${seg(p.sessionID)}`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ title: p.title, permission: p.permission, time: p.time }), o);
    return typed(r, r.data as Ok<SessionUpdateResponses> | undefined);
  }

  async get(p: Flat<SessionGetData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionGetResponses>>> {
    const r = await this.t.send("GET", `/session/${seg(p.sessionID)}`, queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<SessionGetResponses> | undefined);
  }

  async status(p: Flat<SessionStatusData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionStatusResponses>>> {
    const r = await this.t.send("GET", "/session/status", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<SessionStatusResponses> | undefined);
  }

  async promptAsync(p: Flat<SessionPromptAsyncData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionPromptAsyncResponses>>> {
    const r = await this.t.send("POST", `/session/${seg(p.sessionID)}/prompt_async`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ messageID: p.messageID, model: p.model, agent: p.agent, noReply: p.noReply, tools: p.tools, format: p.format, system: p.system, variant: p.variant, parts: p.parts }), o);
    return typed(r, r.data as Ok<SessionPromptAsyncResponses> | undefined);
  }

  async children(p: Flat<SessionChildrenData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionChildrenResponses>>> {
    const r = await this.t.send("GET", `/session/${seg(p.sessionID)}/children`, queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<SessionChildrenResponses> | undefined);
  }

  async delete(p: Flat<SessionDeleteData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionDeleteResponses>>> {
    const r = await this.t.send("DELETE", `/session/${seg(p.sessionID)}`, queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<SessionDeleteResponses> | undefined);
  }

  async revert(p: Flat<SessionRevertData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionRevertResponses>>> {
    const r = await this.t.send("POST", `/session/${seg(p.sessionID)}/revert`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ messageID: p.messageID, partID: p.partID }), o);
    return typed(r, r.data as Ok<SessionRevertResponses> | undefined);
  }

  async summarize(p: Flat<SessionSummarizeData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionSummarizeResponses>>> {
    const r = await this.t.send("POST", `/session/${seg(p.sessionID)}/summarize`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ providerID: p.providerID, modelID: p.modelID, auto: p.auto }), o);
    return typed(r, r.data as Ok<SessionSummarizeResponses> | undefined);
  }

  async command(p: Flat<SessionCommandData>, o?: RequestOptions): Promise<RequestResult<Ok<SessionCommandResponses>>> {
    const r = await this.t.send("POST", `/session/${seg(p.sessionID)}/command`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ messageID: p.messageID, agent: p.agent, model: p.model, arguments: p.arguments, command: p.command, variant: p.variant, parts: p.parts }), o);
    return typed(r, r.data as Ok<SessionCommandResponses> | undefined);
  }
}

class ProviderApi {
  constructor(private readonly t: Transport) {}

  async list(p: Flat<ProviderListData>, o?: RequestOptions): Promise<RequestResult<Ok<ProviderListResponses>>> {
    const r = await this.t.send("GET", "/provider", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<ProviderListResponses> | undefined);
  }
}

class PermissionApi {
  constructor(private readonly t: Transport) {}

  async reply(p: Flat<PermissionReplyData>, o?: RequestOptions): Promise<RequestResult<Ok<PermissionReplyResponses>>> {
    const r = await this.t.send("POST", `/permission/${seg(p.requestID)}/reply`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ reply: p.reply, message: p.message }), o);
    return typed(r, r.data as Ok<PermissionReplyResponses> | undefined);
  }

  async list(p: Flat<PermissionListData>, o?: RequestOptions): Promise<RequestResult<Ok<PermissionListResponses>>> {
    const r = await this.t.send("GET", "/permission", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<PermissionListResponses> | undefined);
  }
}

class AppApi {
  constructor(private readonly t: Transport) {}

  async agents(p: Flat<AppAgentsData>, o?: RequestOptions): Promise<RequestResult<Ok<AppAgentsResponses>>> {
    const r = await this.t.send("GET", "/agent", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<AppAgentsResponses> | undefined);
  }
}

class QuestionApi {
  constructor(private readonly t: Transport) {}

  async reply(p: Flat<QuestionReplyData>, o?: RequestOptions): Promise<RequestResult<Ok<QuestionReplyResponses>>> {
    const r = await this.t.send("POST", `/question/${seg(p.requestID)}/reply`, queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ answers: p.answers }), o);
    return typed(r, r.data as Ok<QuestionReplyResponses> | undefined);
  }

  async reject(p: Flat<QuestionRejectData>, o?: RequestOptions): Promise<RequestResult<Ok<QuestionRejectResponses>>> {
    const r = await this.t.send("POST", `/question/${seg(p.requestID)}/reject`, queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<QuestionRejectResponses> | undefined);
  }

  async list(p: Flat<QuestionListData>, o?: RequestOptions): Promise<RequestResult<Ok<QuestionListResponses>>> {
    const r = await this.t.send("GET", "/question", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<QuestionListResponses> | undefined);
  }
}

class PtyApi {
  constructor(private readonly t: Transport) {}

  async list(p: Flat<PtyListData>, o?: RequestOptions): Promise<RequestResult<Ok<PtyListResponses>>> {
    const r = await this.t.send("GET", "/pty", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<PtyListResponses> | undefined);
  }
}

class McpApi {
  constructor(private readonly t: Transport) {}

  async add(p: Flat<McpAddData>, o?: RequestOptions): Promise<RequestResult<Ok<McpAddResponses>>> {
    const r = await this.t.send("POST", "/mcp", queryString([["directory", p.directory], ["workspace", p.workspace]]), jsonBody({ name: p.name, config: p.config }), o);
    return typed(r, r.data as Ok<McpAddResponses> | undefined);
  }
}

class CommandApi {
  constructor(private readonly t: Transport) {}

  async list(p: Flat<CommandListData>, o?: RequestOptions): Promise<RequestResult<Ok<CommandListResponses>>> {
    const r = await this.t.send("GET", "/command", queryString([["directory", p.directory], ["workspace", p.workspace]]), undefined, o);
    return typed(r, r.data as Ok<CommandListResponses> | undefined);
  }
}

class ExperimentalSessionApi {
  constructor(private readonly t: Transport) {}

  async list(p: Flat<ExperimentalSessionListData>, o?: RequestOptions): Promise<RequestResult<Ok<ExperimentalSessionListResponses>>> {
    const r = await this.t.send("GET", "/experimental/session", queryString([["archived", p.archived], ["roots", p.roots], ["limit", p.limit], ["directory", p.directory], ["workspace", p.workspace], ["start", p.start], ["cursor", p.cursor], ["search", p.search]]), undefined, o);
    return typed(r, r.data as Ok<ExperimentalSessionListResponses> | undefined);
  }
}

class GlobalApi {
  constructor(private readonly t: Transport) {}

  async event(o: ServerSentEventsOptions = {}): Promise<{ stream: AsyncGenerator<GlobalEvent, void, unknown> }> {
    return { stream: this.t.events<GlobalEvent>("/global/event", o) };
  }
}

class ExperimentalApi {
  readonly session: ExperimentalSessionApi;
  constructor(t: Transport) {
    this.session = new ExperimentalSessionApi(t);
  }
}

/** The generated SDK's OpencodeClient, reduced to the calls Paseo makes. */
export class OpencodeClient {
  readonly session: SessionApi;
  readonly provider: ProviderApi;
  readonly permission: PermissionApi;
  readonly app: AppApi;
  readonly question: QuestionApi;
  readonly pty: PtyApi;
  readonly mcp: McpApi;
  readonly command: CommandApi;
  readonly global: GlobalApi;
  readonly experimental: ExperimentalApi;

  constructor(t: Transport) {
    this.session = new SessionApi(t);
    this.provider = new ProviderApi(t);
    this.permission = new PermissionApi(t);
    this.app = new AppApi(t);
    this.question = new QuestionApi(t);
    this.pty = new PtyApi(t);
    this.mcp = new McpApi(t);
    this.command = new CommandApi(t);
    this.global = new GlobalApi(t);
    this.experimental = new ExperimentalApi(t);
  }
}

export function createOpencodeClient(config: OpencodeClientConfig = {}): OpencodeClient {
  return new OpencodeClient(new Transport(config));
}

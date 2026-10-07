/**
 * `proa mcp`: the stdio bridge for stdio-only MCP clients such as Claude
 * Desktop (CONCEPT §5, §6). It relays JSON-RPC messages unchanged between a
 * stdio server transport (the client's side) and a Streamable HTTP client
 * transport to `<PROA_URL>/mcp` that sends `Authorization: Bearer
 * <PROA_TOKEN>`, both from the official MCP SDK. The bridge holds no MCP
 * state of its own, so every protocol revision the server speaks passes
 * through: 2026-07-28 requests carry their version in `_meta` (the HTTP
 * transport derives the headers from the body), and for 2025-era clients the
 * bridge reads the version negotiated by `initialize` and sends it as
 * `MCP-Protocol-Version` on later requests.
 *
 * When the server cannot be reached or rejects the token, every request gets
 * a JSON-RPC error naming the cause, so the client shows it instead of
 * waiting; notifications are dropped and logged. Logs go to stderr only:
 * stdout carries the protocol.
 */
import {
  INTERNAL_ERROR,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

/** The HTTP side: the SDK transport, or a double in tests. */
export type UpstreamTransport = Transport & { setProtocolVersion?(version: string): void };

export interface BridgeOptions {
  /** The client's side, e.g. a `StdioServerTransport` over the process's stdio. */
  downstream: Transport;
  upstream: UpstreamTransport;
  /** Where the bridge forwards to, for messages. */
  endpoint: string;
  log: (line: string) => void;
}

/** The ProA MCP endpoint of a server origin (`http://127.0.0.1:7400` → `…/mcp`). */
export function mcpEndpoint(url: string): URL {
  const base = new URL(url);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError(`PROA_URL must be http(s): ${url}`);
  }
  return new URL(`${base.pathname.replace(/\/+$/, '')}/mcp`, base);
}

/** The SDK's Streamable HTTP client transport with the agent token as bearer. */
export function httpUpstream(
  endpoint: URL,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): UpstreamTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: fetchImpl,
  });
}

function messages(m: JSONRPCMessage | JSONRPCMessage[]): JSONRPCMessage[] {
  return Array.isArray(m) ? m : [m];
}

/** The HTTP status and the problem detail of a failed POST, if the error carries them. */
function httpFailure(err: unknown): { status: number; detail: string | null } | null {
  if (!(err instanceof Error) || !('status' in err) || typeof err.status !== 'number') return null;
  let detail: string | null = null;
  const data: unknown = 'data' in err ? err.data : undefined;
  const text =
    typeof data === 'object' && data !== null && 'text' in data && typeof data.text === 'string'
      ? data.text
      : null;
  if (text) {
    try {
      const problem = JSON.parse(text) as { detail?: unknown };
      detail = typeof problem.detail === 'string' ? problem.detail : null;
    } catch {
      detail = text.slice(0, 200);
    }
  }
  return { status: err.status, detail };
}

function reason(err: unknown, endpoint: string): string {
  const http = httpFailure(err);
  if (err instanceof UnauthorizedError || http?.status === 401) {
    const detail = http?.detail ? `: ${http.detail}` : '';
    return `ProA at ${endpoint} rejected the agent token (401${detail}); check PROA_TOKEN`;
  }
  if (http) {
    return `ProA at ${endpoint} answered HTTP ${http.status}${http.detail ? `: ${http.detail}` : ''}`;
  }
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return `cannot reach ProA at ${endpoint}: ${err.message}${cause}`;
  }
  return `ProA at ${endpoint}: ${String(err)}`;
}

/**
 * Relays messages until the downstream transport closes (the client ends
 * stdin), then closes the upstream transport. Resolves after both are closed.
 */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const { downstream, upstream, endpoint, log } = options;
  const handshakes = new Set<string | number>();

  const toClient = (message: JSONRPCMessage) =>
    downstream.send(message).catch((err: unknown) => {
      log(
        `proa mcp: cannot write to the client: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  upstream.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) && handshakes.delete(message.id)) {
      const version = message.result['protocolVersion'];
      if (typeof version === 'string') upstream.setProtocolVersion?.(version);
    }
    void toClient(message);
  };
  upstream.onerror = (err) => log(`proa mcp: ${reason(err, endpoint)}`);

  downstream.onmessage = (message) => {
    const batch = messages(message);
    for (const m of batch)
      if (isJSONRPCRequest(m) && m.method === 'initialize') handshakes.add(m.id);
    // One POST per message, concurrently: a slow tool call never blocks others.
    upstream.send(message).catch((err: unknown) => {
      const text = reason(err, endpoint);
      const requests = batch.filter(isJSONRPCRequest);
      if (requests.length === 0) log(`proa mcp: dropped a notification: ${text}`);
      for (const r of requests) {
        handshakes.delete(r.id);
        void toClient({ jsonrpc: '2.0', id: r.id, error: { code: INTERNAL_ERROR, message: text } });
      }
    });
  };
  downstream.onerror = (err) => log(`proa mcp: invalid input from the client: ${err.message}`);

  const closed = new Promise<void>((resolve) => {
    downstream.onclose = () => {
      void upstream.close().finally(resolve);
    };
  });
  await upstream.start();
  await downstream.start();
  log(`proa mcp: bridging stdio to ${endpoint}`);
  await closed;
}

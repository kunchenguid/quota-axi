import { getProxyForUrl } from "proxy-from-env";
import type { Dispatcher } from "undici";

/**
 * A configured proxy needs a matching fetch. undici's own fetch honours the
 * `dispatcher` init option, while Node's global fetch only accepts a dispatcher
 * from the undici build Node bundles: Node 26 changed that internal dispatcher
 * contract and rejects this package's `ProxyAgent` with
 * `InvalidArgumentError: invalid onError method`. Carrying the dispatcher and the
 * fetch that consumes it from the same installed build keeps the proxy path
 * independent of the host's Node version.
 */
type ProxyTransport = {
  dispatcher: Dispatcher;
  fetch: typeof import("undici").fetch;
};

export type ProviderFetchNetworkOptions = {
  /**
   * Retry a direct request over IPv4 once when the host's default dual-stack
   * attempt fails to connect, for providers that advertise an IPv6 route this
   * host cannot reach.
   */
  retryOverIpv4?: boolean;
};

/**
 * Failures to reach the host at all, either from the OS socket layer or from
 * undici's own connect timeout. A refused connection means a peer answered, so
 * it is not one of these, and neither is a failure after the request is on the
 * wire; both would fail the same way over IPv4.
 */
const CONNECT_FAILURE_CODES = new Set([
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const PROXY_TRANSPORTS = Symbol.for("quota-axi.proxy-transports");
const sharedGlobals = globalThis as unknown as Record<symbol, unknown>;
const proxyTransports =
  (sharedGlobals[PROXY_TRANSPORTS] as
    | Map<string, Promise<ProxyTransport>>
    | undefined) ?? new Map<string, Promise<ProxyTransport>>();
sharedGlobals[PROXY_TRANSPORTS] = proxyTransports;

const IPV4_TRANSPORT = Symbol.for("quota-axi.ipv4-transport");

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function configuredProxyTransport(
  input: string | URL | Request,
): Promise<ProxyTransport> | undefined {
  const proxyUrl = getProxyForUrl(requestUrl(input));
  if (!proxyUrl) return undefined;
  const existing = proxyTransports.get(proxyUrl);
  if (existing) return existing;
  const transport = import("undici").then(({ ProxyAgent, fetch }) => ({
    dispatcher: new ProxyAgent(proxyUrl),
    fetch,
  }));
  proxyTransports.set(proxyUrl, transport);
  return transport;
}

function ipv4Transport(): Promise<ProxyTransport> {
  const existing = sharedGlobals[IPV4_TRANSPORT] as
    | Promise<ProxyTransport>
    | undefined;
  if (existing) return existing;
  const transport = import("undici").then(({ Agent, fetch }) => ({
    // Undici passes this partial net.connect option through at runtime, but its
    // intersection type incorrectly requires the destination port here.
    dispatcher: new Agent({ connect: { family: 4 } as never }),
    fetch,
  }));
  sharedGlobals[IPV4_TRANSPORT] = transport;
  return transport;
}

function isConnectFailure(error: unknown, depth = 0): boolean {
  if (depth > 4 || !(error instanceof Error)) return false;
  const { code } = error as NodeJS.ErrnoException;
  if (code !== undefined && CONNECT_FAILURE_CODES.has(code)) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((nested) => isConnectFailure(nested, depth + 1))
  )
    return true;
  return isConnectFailure(error.cause, depth + 1);
}

/** Fetch through the host's standard proxy environment when one is configured. */
export async function providerFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  network: ProviderFetchNetworkOptions = {},
): Promise<Response> {
  const configured = configuredProxyTransport(input);
  if (!configured) {
    if (!network.retryOverIpv4) return fetch(input, init);
    try {
      return await fetch(input, init);
    } catch (error) {
      if (!isConnectFailure(error)) throw error;
      return await dispatchedFetch(await ipv4Transport(), input, init);
    }
  }
  return dispatchedFetch(await configured, input, init);
}

async function dispatchedFetch(
  { fetch: transportFetch, dispatcher }: ProxyTransport,
  input: string | URL | Request,
  init: RequestInit,
): Promise<Response> {
  const response = await transportFetch(
    input as Parameters<typeof transportFetch>[0],
    { ...init, dispatcher } as Parameters<typeof transportFetch>[1],
  );
  // The compiler keeps undici's declared Response and the global one apart
  // because undici-types lags its own implementation, but the surface provider
  // adapters use (`status`, `headers`, `text`, `json`) is identical, and the
  // members the declaration misses (`bytes`) exist at runtime.
  return response as unknown as Response;
}

export const PROVIDER_RESPONSE_LIMIT_BYTES = 262_144;

/**
 * Read a provider response body under the shared decoded-size cap. The
 * declared length is checked first, then the streamed accumulation; `fail`
 * maps each rejection code (`response_too_large`, `response_size_unverifiable`,
 * `provider_timeout`) onto the calling adapter's error type.
 */
export async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
  fail: (code: string) => Error,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length")?.trim();
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > PROVIDER_RESPONSE_LIMIT_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw fail("response_too_large");
  }
  if (!response.body) throw fail("response_size_unverifiable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail("provider_timeout");
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > PROVIDER_RESPONSE_LIMIT_BYTES)
        throw fail("response_too_large");
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

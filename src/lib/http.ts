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

const PROXY_TRANSPORTS = Symbol.for("quota-axi.proxy-transports");
const sharedGlobals = globalThis as unknown as Record<symbol, unknown>;
const proxyTransports =
  (sharedGlobals[PROXY_TRANSPORTS] as
    | Map<string, Promise<ProxyTransport>>
    | undefined) ?? new Map<string, Promise<ProxyTransport>>();
sharedGlobals[PROXY_TRANSPORTS] = proxyTransports;

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

/** Fetch through the host's standard proxy environment when one is configured. */
export async function providerFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const transport = await configuredProxyTransport(input);
  if (!transport) return fetch(input, init);
  const { fetch: proxiedFetch, dispatcher } = transport;
  const response = await proxiedFetch(
    input as Parameters<typeof proxiedFetch>[0],
    { ...init, dispatcher } as Parameters<typeof proxiedFetch>[1],
  );
  // The compiler keeps undici's declared Response and the global one apart
  // because undici-types lags its own implementation, but the surface provider
  // adapters use (`status`, `headers`, `text`, `json`) is identical, and the
  // members the declaration misses (`bytes`) exist at runtime.
  return response as unknown as Response;
}

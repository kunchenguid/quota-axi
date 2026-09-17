import { getProxyForUrl } from "proxy-from-env";
import type { Dispatcher } from "undici";

type ProviderRequestInit = RequestInit & { dispatcher?: Dispatcher };

/**
 * A proxy dispatcher and the fetch implementation that owns it travel together:
 * Node's global fetch carries a different undici build than this package's, and
 * handing it this package's `ProxyAgent` fails interface validation on newer
 * Node releases ("invalid onError method"). Requests without a proxy stay on the
 * global fetch.
 */
type ProxyRoute = {
  dispatcher: Dispatcher;
  fetch: typeof globalThis.fetch;
};

const PROXY_ROUTES = Symbol.for("quota-axi.proxy-routes");
const sharedGlobals = globalThis as unknown as Record<symbol, unknown>;
const proxyRoutes =
  (sharedGlobals[PROXY_ROUTES] as
    | Map<string, Promise<ProxyRoute>>
    | undefined) ?? new Map<string, Promise<ProxyRoute>>();
sharedGlobals[PROXY_ROUTES] = proxyRoutes;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function configuredProxyRoute(
  input: string | URL | Request,
): Promise<ProxyRoute> | undefined {
  const proxyUrl = getProxyForUrl(requestUrl(input));
  if (!proxyUrl) return undefined;
  const existing = proxyRoutes.get(proxyUrl);
  if (existing) return existing;
  const route = import("undici").then(({ ProxyAgent, fetch: undiciFetch }) => ({
    dispatcher: new ProxyAgent(proxyUrl),
    fetch: undiciFetch as unknown as typeof globalThis.fetch,
  }));
  proxyRoutes.set(proxyUrl, route);
  return route;
}

/** Fetch through the host's standard proxy environment when one is configured. */
export async function providerFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const route = await configuredProxyRoute(input);
  if (!route) return fetch(input, init);
  return route.fetch(input, {
    ...init,
    dispatcher: route.dispatcher,
  } as ProviderRequestInit);
}

import { Agent, fetch as directFetch } from "undici";

const directDispatcher = new Agent();

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = String(noProxyValue || "").trim();
  if (!noProxy) return false;

  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  return noProxy.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

function hasProxyForValidation(targetUrl, proxyOptions) {
  if (proxyOptions?.vercelRelayUrl) return true;

  const noProxy = proxyOptions?.connectionNoProxy || process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return false;

  if (proxyOptions?.connectionProxyEnabled && proxyOptions?.connectionProxyUrl) return true;

  const protocol = new URL(targetUrl).protocol;
  if (protocol === "https:") {
    return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  }
  return Boolean(process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
}

async function fetchWithTimeout(fetcher, url, options, timeout, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetcher(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("Request timeout") : error;
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Validation starts with a dispatcher that cannot inherit a global proxy.
// A configured proxy is retried only after direct transport fails, never after
// an HTTP response such as 401 or 403.
export async function fetchDirectWithTimeout(url, options = {}, timeout = 15000, retries = 1) {
  return fetchWithTimeout(
    (targetUrl, requestOptions) => directFetch(targetUrl, { ...requestOptions, dispatcher: directDispatcher }),
    url,
    options,
    timeout,
    retries,
  );
}

export async function fetchValidationWithTimeout(url, options = {}, timeout = 15000, retries = 1, proxyOptions = null) {
  try {
    return await fetchDirectWithTimeout(url, options, timeout, retries);
  } catch (error) {
    if (!hasProxyForValidation(url, proxyOptions)) throw error;

    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    return fetchWithTimeout(
      (targetUrl, requestOptions) => proxyAwareFetch(targetUrl, requestOptions, proxyOptions),
      url,
      options,
      timeout,
      retries,
    );
  }
}

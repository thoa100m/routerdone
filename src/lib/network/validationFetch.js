import { fetch as directFetch } from "undici";

// Validation must reach the configured provider directly. It must not inherit
// the application outbound proxy, which can validate a different network path.
export async function fetchDirectWithTimeout(url, options = {}, timeout = 15000, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await directFetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("Request timeout") : error;
      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

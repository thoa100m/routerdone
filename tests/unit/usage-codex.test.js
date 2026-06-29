import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

describe("getCodexUsage", () => {
  it("returns a clear message for network/proxy fetch failures", async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNRESET" };
    mocks.proxyAwareFetch.mockRejectedValue(error);

    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexUsage("access-token");

    expect(result).toEqual({
      message: "Codex usage API fetch failed (ECONNRESET). Check network/proxy or reconnect Codex.",
    });
  });
});
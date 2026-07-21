import { describe, it, expect, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directFetch: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("undici", () => ({ fetch: mocks.directFetch }));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));
vi.mock("@/models", () => ({ getProviderNodeById: mocks.getProviderNodeById }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {},
  isOpenAICompatibleProvider: (provider) => provider === "openai-compatible-test",
  isAnthropicCompatibleProvider: () => false,
  isCustomEmbeddingProvider: () => false,
}));

const originalFetch = global.fetch;

describe("compatible provider validation transport", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("uses direct inference before catalog lookup when adding a Chat Completions key", async () => {
    mocks.getProviderNodeById.mockResolvedValue({
      baseUrl: "https://provider.example/v1",
      apiType: "chat",
    });
    mocks.directFetch.mockResolvedValue({ status: 200 });

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const proxiedFetch = vi.fn(() => Promise.reject(new Error("proxied fetch must not be called")));
    global.fetch = proxiedFetch;
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-test",
        apiKey: "test-key",
        defaultModel: "model-a",
      }),
    }));

    expect(await response.json()).toEqual({ valid: true, method: "chat", error: null });
    expect(mocks.directFetch).toHaveBeenCalledOnce();
    expect(mocks.directFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "model-a",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      }),
    );
    expect(proxiedFetch).not.toHaveBeenCalled();
  });

  it("uses the Responses endpoint and payload when the node requires it", async () => {
    mocks.getProviderNodeById.mockResolvedValue({
      baseUrl: "https://provider.example/v1",
      apiType: "responses",
    });
    mocks.directFetch.mockResolvedValue({ status: 200 });

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-test",
        apiKey: "test-key",
        defaultModel: "model-a",
      }),
    }));

    expect(await response.json()).toEqual({ valid: true, method: "responses", error: null });
    expect(mocks.directFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/responses",
      expect.objectContaining({
        body: JSON.stringify({ model: "model-a", input: "ping", max_output_tokens: 1 }),
      }),
    );
  });

  it("uses direct Responses inference when re-testing a saved compatible connection", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "connection-1",
      provider: "openai-compatible-test",
      authType: "apikey",
      apiKey: "test-key",
      defaultModel: "model-a",
      providerSpecificData: {
        baseUrl: "https://provider.example/v1",
        apiType: "responses",
      },
    });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.directFetch.mockResolvedValue({ status: 200 });

    const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
    const proxiedFetch = vi.fn(() => Promise.reject(new Error("proxied fetch must not be called")));
    global.fetch = proxiedFetch;
    const result = await testSingleConnection("connection-1");

    expect(result).toMatchObject({ valid: true });
    expect(mocks.directFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/responses",
      expect.objectContaining({
        body: JSON.stringify({ model: "model-a", input: "ping", max_output_tokens: 1 }),
      }),
    );
    expect(proxiedFetch).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("connection-1", expect.objectContaining({
      testStatus: "active",
      lastError: null,
    }));
  });
});

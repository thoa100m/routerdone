import { describe, it, expect, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directFetch: vi.fn(),
  proxyAwareFetch: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  ensureOutboundProxyInitialized: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: class Agent {},
  fetch: mocks.directFetch,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
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
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxyUrl }));
vi.mock("@/lib/network/initOutboundProxy", () => ({
  ensureOutboundProxyInitialized: mocks.ensureOutboundProxyInitialized,
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {},
  isOpenAICompatibleProvider: (provider) => provider === "openai-compatible-test",
  isAnthropicCompatibleProvider: () => false,
  isCustomEmbeddingProvider: () => false,
}));

const originalFetch = global.fetch;
const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalNoProxy = process.env.NO_PROXY;

function configureCompatibleNode(apiType = "chat") {
  mocks.getProviderNodeById.mockResolvedValue({
    baseUrl: "https://provider.example/v1",
    apiType,
  });
}

function configureCompatibleConnection(apiType = "responses") {
  mocks.getProviderConnectionById.mockResolvedValue({
    id: "connection-1",
    provider: "openai-compatible-test",
    authType: "apikey",
    apiKey: "test-key",
    defaultModel: "model-a",
    providerSpecificData: {
      baseUrl: "https://provider.example/v1",
      apiType,
    },
  });
}

function makeValidationRequest() {
  return new Request("http://localhost/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "openai-compatible-test",
      apiKey: "test-key",
      defaultModel: "model-a",
    }),
  });
}

describe("compatible provider validation transport", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    global.fetch = originalFetch;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = originalNoProxy;
  });

  it("uses direct inference before catalog lookup when adding a Chat Completions key", async () => {
    configureCompatibleNode();
    mocks.directFetch.mockResolvedValue({ ok: true, status: 200 });
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const proxiedFetch = vi.fn(() => Promise.reject(new Error("proxied fetch must not be called")));
    global.fetch = proxiedFetch;
    const response = await POST(makeValidationRequest());

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
        dispatcher: expect.anything(),
      }),
    );
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    expect(proxiedFetch).not.toHaveBeenCalled();
  });

  it("uses the Responses endpoint and payload when the node requires it", async () => {
    configureCompatibleNode("responses");
    mocks.directFetch.mockResolvedValue({ ok: true, status: 200 });
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(makeValidationRequest());

    expect(await response.json()).toEqual({ valid: true, method: "responses", error: null });
    expect(mocks.directFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/responses",
      expect.objectContaining({
        body: JSON.stringify({ model: "model-a", input: "ping", max_output_tokens: 1 }),
      }),
    );
  });

  it("retries through the outbound proxy only after a direct network failure", async () => {
    configureCompatibleNode();
    mocks.directFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200 });
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);
    process.env.HTTPS_PROXY = "http://proxy.example:8080";

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(makeValidationRequest());

    expect(await response.json()).toEqual({ valid: true, method: "chat", error: null });
    expect(mocks.directFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
      null,
    );
  });

  it("respects NO_PROXY when direct validation fails", async () => {
    configureCompatibleNode();
    mocks.directFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "provider.example";

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(makeValidationRequest());

    expect(await response.json()).toEqual({
      valid: false,
      method: "chat",
      error: "Provider inference request failed",
    });
    expect(mocks.directFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("does not retry through the proxy after an authentication response", async () => {
    configureCompatibleNode();
    mocks.directFetch.mockResolvedValue({ ok: false, status: 401 });
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);
    process.env.HTTPS_PROXY = "http://proxy.example:8080";

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(makeValidationRequest());

    expect(await response.json()).toEqual({ valid: false, method: "chat", error: "Invalid API key" });
    expect(mocks.directFetch).toHaveBeenCalledOnce();
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("reports non-auth upstream errors without marking the key valid", async () => {
    configureCompatibleNode();
    mocks.directFetch.mockResolvedValue({ ok: false, status: 400 });
    mocks.ensureOutboundProxyInitialized.mockResolvedValue(true);

    const { POST } = await import("@/app/api/providers/validate/route.js");
    const response = await POST(makeValidationRequest());

    expect(await response.json()).toEqual({
      valid: false,
      method: "chat",
      error: "Provider inference request failed (400)",
    });
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("retries a saved compatible connection through its assigned proxy", async () => {
    configureCompatibleConnection();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://connection-proxy.example:8080",
      connectionNoProxy: "",
    });
    mocks.directFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200 });
    mocks.testProxyUrl.mockResolvedValue({ ok: true });

    const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
    const result = await testSingleConnection("connection-1");

    expect(result).toMatchObject({ valid: true });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://provider.example/v1/responses",
      expect.objectContaining({
        body: JSON.stringify({ model: "model-a", input: "ping", max_output_tokens: 1 }),
      }),
      expect.objectContaining({ connectionProxyUrl: "http://connection-proxy.example:8080" }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("connection-1", expect.objectContaining({
      testStatus: "active",
      lastError: null,
    }));
  });
});

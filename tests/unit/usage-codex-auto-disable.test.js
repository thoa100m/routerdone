import { describe, it, expect, vi, beforeEach } from "vitest";

const connection = {
  id: "codex-conn-1",
  provider: "codex",
  authType: "oauth",
  isActive: true,
  accessToken: "access-token",
  refreshToken: null,
  providerSpecificData: {},
};

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getExecutor: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_APIKEY_PROVIDERS: [],
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

describe("Codex usage auth failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({ ...connection });
    mocks.updateProviderConnection.mockResolvedValue(null);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getExecutor.mockReturnValue({
      needsRefresh: () => false,
      refreshCredentials: vi.fn(),
    });
  });

  it("turns off a Codex account when quota usage returns 401 unavailable", async () => {
    mocks.getUsageForProvider.mockResolvedValue({
      message: "Codex connected. Usage API temporarily unavailable (401).",
    });

    const { fetchConnectionUsage } = await import("../../src/app/api/usage/_shared.js");
    const result = await fetchConnectionUsage(connection.id);

    expect(result.ok).toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({
        isActive: false,
        testStatus: "auth_error",
        lastError: "Codex connected. Usage API temporarily unavailable (401).",
        errorCode: "usage_api_401",
      }),
    );
    expect(mocks.updateProviderConnection.mock.calls[0][1].lastErrorAt).toEqual(expect.any(String));
  });

  it("does not turn off Codex for temporary non-auth quota failures", async () => {
    mocks.getUsageForProvider.mockResolvedValue({
      message: "Codex connected. Usage API temporarily unavailable (503).",
    });

    const { fetchConnectionUsage } = await import("../../src/app/api/usage/_shared.js");
    await fetchConnectionUsage(connection.id);

    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
  it("turns off a Codex account when credential refresh is unrecoverable", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      ...connection,
      refreshToken: "stale-refresh-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    mocks.getExecutor.mockReturnValue({
      needsRefresh: () => true,
      refreshCredentials: vi.fn().mockResolvedValue({
        error: "unrecoverable_refresh_error",
        code: "refresh_token_invalidated",
      }),
    });

    const { fetchConnectionUsage } = await import("../../src/app/api/usage/_shared.js");
    const result = await fetchConnectionUsage(connection.id);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("Codex refresh token invalid. Re-auth required.");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({
        isActive: false,
        testStatus: "auth_error",
        lastError: "Codex refresh token invalid. Re-auth required.",
        errorCode: "refresh_token_invalidated",
      }),
    );
  });
});
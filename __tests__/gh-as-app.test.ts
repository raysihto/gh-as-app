import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type CacheEntry,
  type Dependencies,
  deleteCache,
  getRepoInfo,
  issueToken,
  main,
  readCache,
  resolveClientId,
  runGh,
  validateAppSlug,
  writeCache,
} from "../src/gh-as-app.js";

const CREDENTIALS_DIR = "/mock-credentials";
const CACHE_DIR = "/mock-cache";

function createTestDeps(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    execFile: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    createAppAuth: vi.fn(),
    fetch: vi.fn(),
    credentialsDir: CREDENTIALS_DIR,
    cacheDir: CACHE_DIR,
    argv: [],
    env: {},
    exit: vi.fn().mockImplementation((code: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }),
    stderr: vi.fn(),
    ...overrides,
  } as unknown as Dependencies;
}

// ---------------------------------------------------------------------------
// getRepoInfo
// ---------------------------------------------------------------------------
describe("getRepoInfo", () => {
  it("parses owner and repo from gh output", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockReturnValue(JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" }));
    expect(getRepoInfo(deps)).toEqual({ owner: "myorg", repo: "myrepo" });
    expect(deps.execFile).toHaveBeenCalledWith("gh", ["repo", "view", "--json", "owner,name"], {
      encoding: "utf8",
    });
  });

  it("throws when gh command fails", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      throw new Error("gh not found");
    });
    expect(() => getRepoInfo(deps)).toThrow("gh not found");
  });
});

// ---------------------------------------------------------------------------
// validateAppSlug
// ---------------------------------------------------------------------------
describe("validateAppSlug", () => {
  it("accepts valid slugs", () => {
    expect(() => validateAppSlug("my-app")).not.toThrow();
    expect(() => validateAppSlug("app123")).not.toThrow();
    expect(() => validateAppSlug("a")).not.toThrow();
  });

  it("rejects slugs with path separators", () => {
    expect(() => validateAppSlug("../evil")).toThrow("Invalid app slug");
    expect(() => validateAppSlug("foo/bar")).toThrow("Invalid app slug");
  });

  it("rejects empty or invalid slugs", () => {
    expect(() => validateAppSlug("")).toThrow("Invalid app slug");
    expect(() => validateAppSlug("-starts-with-dash")).toThrow("Invalid app slug");
    expect(() => validateAppSlug("UPPERCASE")).toThrow("Invalid app slug");
  });
});

// ---------------------------------------------------------------------------
// resolveClientId
// ---------------------------------------------------------------------------
describe("resolveClientId", () => {
  it("returns trimmed client_id", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockReturnValue("  Iv1.abc123  \n");
    expect(resolveClientId(deps, "my-app")).toBe("Iv1.abc123");
    expect(deps.execFile).toHaveBeenCalledWith("gh", ["api", "/apps/my-app", "--jq", ".client_id"], {
      encoding: "utf8",
    });
  });

  it("throws when client_id is empty", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockReturnValue("  \n");
    expect(() => resolveClientId(deps, "my-app")).toThrow('Failed to resolve client_id for app "my-app"');
  });

  it("throws when gh command fails", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() => resolveClientId(deps, "my-app")).toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// readCache
// ---------------------------------------------------------------------------
describe("readCache", () => {
  it("returns null when file does not exist", () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(false);
    expect(readCache(deps, "my-app", "owner", "repo")).toBeNull();
    expect(deps.exists).toHaveBeenCalledWith(join(CACHE_DIR, "my-app@owner_repo.json"));
  });

  it("returns entry when cache is valid and not expired", () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const entry: CacheEntry = { clientId: "Iv1.abc", token: "ghs_xxx", expiresAt: futureDate };
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue(JSON.stringify(entry));
    expect(readCache(deps, "my-app", "owner", "repo")).toEqual(entry);
  });

  it("returns null when cache is expired", () => {
    const pastDate = new Date(Date.now() - 3_600_000).toISOString();
    const entry: CacheEntry = { clientId: "Iv1.abc", token: "ghs_xxx", expiresAt: pastDate };
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue(JSON.stringify(entry));
    expect(readCache(deps, "my-app", "owner", "repo")).toBeNull();
  });

  it("returns null when JSON is invalid", () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue("not-json");
    expect(readCache(deps, "my-app", "owner", "repo")).toBeNull();
  });

  it("returns null when expiresAt is not a valid date", () => {
    const entry: CacheEntry = { clientId: "Iv1.abc", token: "ghs_xxx", expiresAt: "not-a-date" };
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue(JSON.stringify(entry));
    expect(readCache(deps, "my-app", "owner", "repo")).toBeNull();
  });

  it.each([
    { label: "missing token", json: { clientId: "Iv1.abc", token: "", expiresAt: "2099-01-01T00:00:00Z" } },
    { label: "missing clientId", json: { clientId: "", token: "ghs_xxx", expiresAt: "2099-01-01T00:00:00Z" } },
    { label: "missing expiresAt", json: { clientId: "Iv1.abc", token: "ghs_xxx", expiresAt: "" } },
    { label: "non-string token", json: { clientId: "Iv1.abc", token: 123, expiresAt: "2099-01-01T00:00:00Z" } },
    { label: "null fields", json: { clientId: null, token: null, expiresAt: null } },
  ])("returns null when entry shape is invalid ($label)", ({ json }) => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue(JSON.stringify(json));
    expect(readCache(deps, "my-app", "owner", "repo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeCache
// ---------------------------------------------------------------------------
describe("writeCache", () => {
  it("creates directory and writes file", () => {
    const deps = createTestDeps();
    const entry: CacheEntry = { clientId: "Iv1.abc", token: "ghs_xxx", expiresAt: "2025-01-01T00:00:00Z" };
    writeCache(deps, "my-app", "owner", "repo", entry);
    expect(deps.mkdir).toHaveBeenCalledWith(CACHE_DIR, { recursive: true, mode: 0o700 });
    expect(deps.writeFile).toHaveBeenCalledWith(
      join(CACHE_DIR, "my-app@owner_repo.json"),
      JSON.stringify(entry, null, 2) + "\n",
      { mode: 0o600 },
    );
  });
});

// ---------------------------------------------------------------------------
// deleteCache
// ---------------------------------------------------------------------------
describe("deleteCache", () => {
  it("deletes file when it exists", () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    deleteCache(deps, "my-app", "owner", "repo");
    expect(deps.unlink).toHaveBeenCalledWith(join(CACHE_DIR, "my-app@owner_repo.json"));
  });

  it("does nothing when file does not exist", () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(false);
    deleteCache(deps, "my-app", "owner", "repo");
    expect(deps.unlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// issueToken
// ---------------------------------------------------------------------------
describe("issueToken", () => {
  it("issues token successfully", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue("-----PEM-----");

    const mockAuthFn = vi
      .fn()
      .mockResolvedValueOnce({ token: "jwt-token" })
      .mockResolvedValueOnce({ token: "ghs_install", expiresAt: "2025-01-01T00:00:00Z" });
    // @ts-expect-error -- test mock does not implement full AuthInterface
    vi.mocked(deps.createAppAuth).mockReturnValue(mockAuthFn);

    vi.mocked(deps.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 12345 }),
    } as Response);

    const result = await issueToken(deps, "Iv1.abc", "my-app", "owner", "repo");
    expect(result).toEqual({ token: "ghs_install", expiresAt: "2025-01-01T00:00:00Z" });
    expect(deps.createAppAuth).toHaveBeenCalledWith({ appId: "Iv1.abc", privateKey: "-----PEM-----" });
    expect(deps.readFile).toHaveBeenCalledWith(join(CREDENTIALS_DIR, "my-app.pem"), "utf8");
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/installation",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-token" }) as Record<string, string>,
      }),
    );
    expect(mockAuthFn).toHaveBeenCalledWith({ type: "app" });
    expect(mockAuthFn).toHaveBeenCalledWith({ type: "installation", installationId: 12345 });
  });

  it("throws when PEM file not found", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(false);
    await expect(issueToken(deps, "Iv1.abc", "my-app", "owner", "repo")).rejects.toThrow("PEM file not found");
  });

  it("throws when installation fetch fails", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue("-----PEM-----");

    const mockAuthFn = vi.fn().mockResolvedValueOnce({ token: "jwt-token" });
    // @ts-expect-error -- test mock does not implement full AuthInterface
    vi.mocked(deps.createAppAuth).mockReturnValue(mockAuthFn);

    vi.mocked(deps.fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await expect(issueToken(deps, "Iv1.abc", "my-app", "owner", "repo")).rejects.toThrow(
      "Failed to get installation for owner/repo: 404 Not Found",
    );
  });

  it("throws when installation ID is missing or invalid", async () => {
    const deps = createTestDeps();
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValue("-----PEM-----");

    const mockAuthFn = vi.fn().mockResolvedValueOnce({ token: "jwt-token" });
    // @ts-expect-error -- test mock does not implement full AuthInterface
    vi.mocked(deps.createAppAuth).mockReturnValue(mockAuthFn);

    vi.mocked(deps.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ name: "no-id-field" }),
    } as Response);

    await expect(issueToken(deps, "Iv1.abc", "my-app", "owner", "repo")).rejects.toThrow(
      "Unexpected installation response for owner/repo: missing or invalid installation ID",
    );
  });
});

// ---------------------------------------------------------------------------
// runGh
// ---------------------------------------------------------------------------
describe("runGh", () => {
  it("returns 0 on success", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockReturnValue(Buffer.from(""));
    expect(runGh(deps, ["pr", "list"], "ghs_token")).toBe(0);
    expect(deps.execFile).toHaveBeenCalledWith("gh", ["pr", "list"], {
      env: expect.objectContaining({ GH_TOKEN: "ghs_token" }) as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
  });

  it("returns error status code when error has status property", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      throw Object.assign(new Error("command failed"), { status: 42 });
    });
    expect(runGh(deps, ["pr", "list"], "ghs_token")).toBe(42);
  });

  it("returns 1 when error has no status property", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      throw new Error("unknown");
    });
    expect(runGh(deps, ["pr", "list"], "ghs_token")).toBe(1);
  });

  it("returns 1 when error has status: null (signal kill)", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      throw Object.assign(new Error("killed"), { status: null, signal: "SIGTERM" });
    });
    expect(runGh(deps, ["pr", "list"], "ghs_token")).toBe(1);
  });

  it("returns 1 when error is null", () => {
    const deps = createTestDeps();
    vi.mocked(deps.execFile).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error throw
      throw null;
    });
    expect(runGh(deps, ["pr", "list"], "ghs_token")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
describe("main", () => {
  it("exits with 2 when insufficient arguments", async () => {
    const deps = createTestDeps({ argv: ["only-one-arg"] });
    await main(deps).catch(() => {});
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.stderr).toHaveBeenCalledWith("Usage: gh-as <app-slug> <gh-args...>");
  });

  it("exits with 2 when no arguments", async () => {
    const deps = createTestDeps();
    await main(deps).catch(() => {});
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it("uses cached token and exits on success", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const cached: CacheEntry = { clientId: "Iv1.abc", token: "ghs_cached", expiresAt: futureDate };

    const deps = createTestDeps({ argv: ["my-app", "pr", "list"] });

    // getRepoInfo
    vi.mocked(deps.execFile).mockReturnValueOnce(JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" }));

    // readCache
    vi.mocked(deps.exists).mockReturnValueOnce(true); // cache file exists
    vi.mocked(deps.readFile).mockReturnValueOnce(JSON.stringify(cached));

    // runGh (cached token) succeeds
    vi.mocked(deps.execFile).mockReturnValueOnce(Buffer.from(""));

    await main(deps).catch(() => {});
    expect(deps.exit).toHaveBeenNthCalledWith(1, 0);
  });

  it("reissues token when cached token returns exit code 4", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const cached: CacheEntry = { clientId: "Iv1.abc", token: "ghs_old", expiresAt: futureDate };

    const deps = createTestDeps({ argv: ["my-app", "pr", "list"] });

    let execCallCount = 0;
    vi.mocked(deps.execFile).mockImplementation(() => {
      execCallCount++;
      if (execCallCount === 1) {
        // getRepoInfo
        return JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" });
      }
      if (execCallCount === 2) {
        // runGh with cached token → auth error (exit 4)
        throw Object.assign(new Error("auth error"), { status: 4 });
      }
      if (execCallCount === 3) {
        // resolveClientId
        return "Iv1.abc\n";
      }
      // runGh with new token
      return Buffer.from("");
    });

    // readCache → valid cache; deleteCache → file exists; issueToken → PEM exists
    vi.mocked(deps.exists).mockReturnValue(true);
    vi.mocked(deps.readFile).mockReturnValueOnce(JSON.stringify(cached)); // readCache
    vi.mocked(deps.readFile).mockReturnValueOnce("-----PEM-----"); // issueToken PEM

    const mockAuthFn = vi
      .fn()
      .mockResolvedValueOnce({ token: "jwt-token" })
      .mockResolvedValueOnce({ token: "ghs_new", expiresAt: "2025-12-01T00:00:00Z" });
    // @ts-expect-error -- test mock does not implement full AuthInterface
    vi.mocked(deps.createAppAuth).mockReturnValue(mockAuthFn);

    vi.mocked(deps.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 12345 }),
    } as Response);

    await main(deps).catch(() => {});

    expect(deps.stderr).toHaveBeenCalledWith("Cached token rejected, reissuing...");
    expect(deps.unlink).toHaveBeenCalled();
    expect(deps.writeFile).toHaveBeenCalled();
    // First process.exit should be with the new token's exit code (0)
    expect(deps.exit).toHaveBeenNthCalledWith(1, 0);
  });

  it("issues fresh token when no cache exists", async () => {
    const deps = createTestDeps({ argv: ["my-app", "pr", "list"] });

    let execCallCount = 0;
    vi.mocked(deps.execFile).mockImplementation(() => {
      execCallCount++;
      if (execCallCount === 1) {
        // getRepoInfo
        return JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" });
      }
      if (execCallCount === 2) {
        // resolveClientId
        return "Iv1.abc\n";
      }
      // runGh
      return Buffer.from("");
    });

    // readCache → no cache; issueToken → PEM exists
    vi.mocked(deps.exists).mockReturnValueOnce(false); // cache file doesn't exist
    vi.mocked(deps.exists).mockReturnValueOnce(true); // PEM exists
    vi.mocked(deps.readFile).mockReturnValue("-----PEM-----");

    const mockAuthFn = vi
      .fn()
      .mockResolvedValueOnce({ token: "jwt-token" })
      .mockResolvedValueOnce({ token: "ghs_fresh", expiresAt: "2025-12-01T00:00:00Z" });
    // @ts-expect-error -- test mock does not implement full AuthInterface
    vi.mocked(deps.createAppAuth).mockReturnValue(mockAuthFn);

    vi.mocked(deps.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 12345 }),
    } as Response);

    await main(deps).catch(() => {});

    expect(deps.writeFile).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenNthCalledWith(1, 0);
  });

  it("exits with 1 and logs error when token issuance fails", async () => {
    const deps = createTestDeps({ argv: ["my-app", "pr", "list"] });

    // getRepoInfo
    vi.mocked(deps.execFile).mockReturnValueOnce(JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" }));
    // resolveClientId throws
    vi.mocked(deps.execFile).mockImplementationOnce(() => {
      throw new Error("API rate limit exceeded");
    });

    // no cache
    vi.mocked(deps.exists).mockReturnValue(false);

    await main(deps).catch(() => {});

    expect(deps.stderr).toHaveBeenCalledWith("Error: API rate limit exceeded");
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("exits with 1 and handles non-Error thrown values", async () => {
    const deps = createTestDeps({ argv: ["my-app", "pr", "list"] });

    // getRepoInfo
    vi.mocked(deps.execFile).mockReturnValueOnce(JSON.stringify({ owner: { login: "myorg" }, name: "myrepo" }));
    // resolveClientId throws non-Error
    vi.mocked(deps.execFile).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error throw
      throw "string error";
    });

    vi.mocked(deps.exists).mockReturnValue(false);

    await main(deps).catch(() => {});

    expect(deps.stderr).toHaveBeenCalledWith("Error: string error");
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});

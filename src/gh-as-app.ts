import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAppAuth } from "@octokit/auth-app";

export interface Dependencies {
  execFile: typeof execFileSync;
  exists: typeof existsSync;
  readFile: typeof readFileSync;
  writeFile: typeof writeFileSync;
  mkdir: typeof mkdirSync;
  unlink: typeof unlinkSync;
  createAppAuth: typeof createAppAuth;
  fetch: typeof globalThis.fetch;
  credentialsDir: string;
  cacheDir: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
  stderr: (message: string) => void;
}

export interface CacheEntry {
  clientId: string;
  token: string;
  expiresAt: string;
}

const APP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validateAppSlug(slug: string): void {
  if (!APP_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid app slug: "${slug}". Slugs must start with a lowercase alphanumeric character and contain only lowercase alphanumeric characters and hyphens.`,
    );
  }
}

/**
 * gh repo view で owner/repo を取得
 */
export function getRepoInfo(deps: Dependencies): { owner: string; repo: string } {
  const output = deps.execFile("gh", ["repo", "view", "--json", "owner,name"], {
    encoding: "utf8",
  });
  const data = JSON.parse(output) as { owner: { login: string }; name: string };
  return { owner: data.owner.login, repo: data.name };
}

/**
 * app-slug → client_id を解決 (gh api 経由で認証付きリクエスト)
 */
export function resolveClientId(deps: Dependencies, appSlug: string): string {
  const output = deps.execFile("gh", ["api", `/apps/${appSlug}`, "--jq", ".client_id"], {
    encoding: "utf8",
  });
  const clientId = output.trim();
  if (!clientId) {
    throw new Error(`Failed to resolve client_id for app "${appSlug}"`);
  }
  return clientId;
}

/**
 * キャッシュ読み込み (期限切れなら null)
 */
export function readCache(deps: Dependencies, appSlug: string, owner: string, repo: string): CacheEntry | null {
  const path = join(deps.cacheDir, `${appSlug}@${owner}_${repo}.json`);
  if (!deps.exists(path)) {
    return null;
  }
  try {
    const entry = JSON.parse(deps.readFile(path, "utf8")) as CacheEntry;
    if (
      typeof entry.token !== "string" ||
      entry.token === "" ||
      typeof entry.clientId !== "string" ||
      entry.clientId === "" ||
      typeof entry.expiresAt !== "string" ||
      entry.expiresAt === ""
    ) {
      return null;
    }
    const expiresAt = new Date(entry.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * キャッシュ書き込み
 */
export function writeCache(deps: Dependencies, appSlug: string, owner: string, repo: string, entry: CacheEntry): void {
  deps.mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
  deps.writeFile(join(deps.cacheDir, `${appSlug}@${owner}_${repo}.json`), JSON.stringify(entry, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * キャッシュ削除
 */
export function deleteCache(deps: Dependencies, appSlug: string, owner: string, repo: string): void {
  const path = join(deps.cacheDir, `${appSlug}@${owner}_${repo}.json`);
  if (deps.exists(path)) {
    deps.unlink(path);
  }
}

/**
 * インストールトークンを発行
 */
export async function issueToken(
  deps: Dependencies,
  clientId: string,
  appSlug: string,
  owner: string,
  repo: string,
): Promise<{ token: string; expiresAt: string }> {
  const pemPath = join(deps.credentialsDir, `${appSlug}.pem`);
  if (!deps.exists(pemPath)) {
    throw new Error(`PEM file not found: ${pemPath}`);
  }
  const privateKey = deps.readFile(pemPath, "utf8");

  const auth = deps.createAppAuth({ appId: clientId, privateKey });

  // JWT で installation_id を取得
  const { token: jwt } = await auth({ type: "app" });
  const installRes = await deps.fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!installRes.ok) {
    throw new Error(`Failed to get installation for ${owner}/${repo}: ${installRes.status} ${installRes.statusText}`);
  }
  const { id: installationId } = (await installRes.json()) as { id: number };
  if (!Number.isFinite(installationId)) {
    throw new Error(`Unexpected installation response for ${owner}/${repo}: missing or invalid installation ID`);
  }

  // インストールトークン発行
  const tokenAuth = await auth({ type: "installation", installationId });
  return { token: tokenAuth.token, expiresAt: tokenAuth.expiresAt };
}

/**
 * gh コマンドを実行し終了コードを返す
 */
export function runGh(deps: Dependencies, ghArgs: string[], token: string): number {
  try {
    deps.execFile("gh", ghArgs, {
      env: { ...deps.env, GH_TOKEN: token },
      stdio: "inherit",
    });
    return 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) {
      return (error as { status: number | null }).status ?? 1;
    }
    return 1;
  }
}

export async function main(deps: Dependencies): Promise<void> {
  if (deps.argv.length < 2) {
    deps.stderr("Usage: gh-as <app-slug> <gh-args...>");
    deps.exit(2);
  }

  const appSlug = deps.argv[0]!;
  validateAppSlug(appSlug);
  const ghArgs = deps.argv.slice(1);
  const { owner, repo } = getRepoInfo(deps);

  // キャッシュからトークンを取得して実行を試みる
  const cached = readCache(deps, appSlug, owner, repo);
  if (cached) {
    const exitCode = runGh(deps, ghArgs, cached.token);
    if (exitCode !== 4) {
      deps.exit(exitCode);
    }
    // 認証エラー — キャッシュ破棄して再発行
    deps.stderr("Cached token rejected, reissuing...");
    deleteCache(deps, appSlug, owner, repo);
  }

  // client_id 解決 → トークン発行 → キャッシュ → 実行
  try {
    const clientId = resolveClientId(deps, appSlug);
    const { token, expiresAt } = await issueToken(deps, clientId, appSlug, owner, repo);
    writeCache(deps, appSlug, owner, repo, { clientId, token, expiresAt });

    const exitCode = runGh(deps, ghArgs, token);
    deps.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`Error: ${message}`);
    deps.exit(1);
  }
}

function createDependencies(): Dependencies {
  const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  const cacheHome = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return {
    execFile: execFileSync,
    exists: existsSync,
    readFile: readFileSync,
    writeFile: writeFileSync,
    mkdir: mkdirSync,
    unlink: unlinkSync,
    createAppAuth,
    fetch: globalThis.fetch,
    credentialsDir: join(configHome, "gh-as", "credentials"),
    cacheDir: join(cacheHome, "gh-as"),
    argv: process.argv.slice(2),
    env: process.env,
    exit: (code: number) => process.exit(code),
    stderr: (message: string) => console.error(message),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(createDependencies());
}

import type { OpenClawConnection } from "./protocol.js";

declare global {
  var __openclawPlaygroundEnv: Record<string, string | undefined> | undefined;
}

export interface PlaygroundEnvConfig {
  gatewayUrl?: string;
  gatewayToken?: string;
  agentId: string;
  enabledCollections?: string[];
  locked: boolean;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export const PLAYGROUND_LOCKED_MESSAGE =
  "OpenClaw Gateway settings are pre-configured and locked in Playground mode.";

const SENSITIVE_QUERY_KEYS = [
  "token",
  "bootstrapToken",
  "deviceToken",
  "password",
  "secret",
  "apiKey",
  "api_key",
  "access_token",
  "auth",
] as const;

function sanitizePlaygroundGatewayUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }
  const hostClean = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostClean === "127.0.0.1" || hostClean === "localhost" || hostClean === "::1";
  if ((parsed.protocol === "http:" || parsed.protocol === "ws:") && !isLoopback) {
    return undefined;
  }
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    return undefined;
  }
  parsed.hash = "";
  for (const k of SENSITIVE_QUERY_KEYS) {
    parsed.searchParams.delete(k);
  }
  return parsed.toString().replace(/\/$/, "");
}

function readEnvValue(key: string, extraEnv?: Record<string, unknown>): string | undefined {
  const fromExtra = extraEnv?.[key];
  if (typeof fromExtra === "string" && fromExtra.trim().length > 0) {
    return fromExtra.trim();
  }
  const fromGlobal = globalThis.__openclawPlaygroundEnv?.[key];
  if (typeof fromGlobal === "string" && fromGlobal.trim().length > 0) {
    return fromGlobal.trim();
  }
  const procEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const fromProc = procEnv?.[key];
  if (typeof fromProc === "string" && fromProc.trim().length > 0) {
    return fromProc.trim();
  }
  return undefined;
}

export function extractRouteRuntimeEnv(routeOrCtx: unknown): Record<string, unknown> | undefined {
  if (!routeOrCtx || typeof routeOrCtx !== "object") return undefined;
  const rec = routeOrCtx as {
    env?: unknown;
    locals?: { runtime?: { env?: unknown } };
  };
  if (rec.locals?.runtime?.env && typeof rec.locals.runtime.env === "object") {
    return rec.locals.runtime.env as Record<string, unknown>;
  }
  if (rec.env && typeof rec.env === "object") {
    return rec.env as Record<string, unknown>;
  }
  return undefined;
}

export function readPlaygroundEnvConfig(extraEnv?: Record<string, unknown>): PlaygroundEnvConfig {
  const rawUrl = readEnvValue("OPENCLAW_PLAYGROUND_GATEWAY_URL", extraEnv);
  const gatewayUrl = rawUrl ? sanitizePlaygroundGatewayUrl(rawUrl) : undefined;
  const gatewayToken = readEnvValue("OPENCLAW_PLAYGROUND_GATEWAY_TOKEN", extraEnv);
  const rawAgent = readEnvValue("OPENCLAW_PLAYGROUND_AGENT_ID", extraEnv);
  const agentId = rawAgent && /[a-z0-9]/i.test(rawAgent) ? rawAgent.slice(0, 80) : "blobster-smith";

  const rawCollections = readEnvValue("OPENCLAW_PLAYGROUND_ENABLED_COLLECTIONS", extraEnv);
  const enabledCollections = rawCollections
    ? rawCollections
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    : undefined;

  const rawLock = readEnvValue("OPENCLAW_PLAYGROUND_LOCK", extraEnv);
  const locked = rawLock === "1" || rawLock?.toLowerCase() === "true";

  const cfAccessClientId = readEnvValue("OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_ID", extraEnv);
  const cfAccessClientSecret = readEnvValue(
    "OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_SECRET",
    extraEnv,
  );

  return {
    gatewayUrl,
    gatewayToken,
    agentId,
    enabledCollections,
    locked,
    cfAccessClientId,
    cfAccessClientSecret,
  };
}

export function isPlaygroundLocked(extraEnv?: Record<string, unknown>): boolean {
  return readPlaygroundEnvConfig(extraEnv).locked;
}

export function resolvePlaygroundConnection(
  fallbackCollectionSlugs: string[],
  extraEnv?: Record<string, unknown>,
): OpenClawConnection | null {
  const cfg = readPlaygroundEnvConfig(extraEnv);
  if (!cfg.gatewayUrl || !cfg.gatewayToken) {
    return null;
  }
  return {
    gatewayUrl: cfg.gatewayUrl,
    agentId: cfg.agentId,
    gatewayToken: cfg.gatewayToken,
    authorityMode: "propose_with_approval",
    allowGatewayExecApprovals: false,
    enabledCollections:
      cfg.enabledCollections && cfg.enabledCollections.length > 0
        ? cfg.enabledCollections
        : fallbackCollectionSlugs,
  };
}

export function isSameGatewayOrigin(targetUrl: string, configuredUrl: string): boolean {
  try {
    return new URL(targetUrl).origin === new URL(configuredUrl).origin;
  } catch {
    return false;
  }
}

function readHeaderCaseInsensitive(headers: unknown, lowerName: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get: (k: string) => string | null }).get(lowerName);
    return typeof val === "string" ? val : undefined;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lowerName) {
        if (typeof v === "string") return v;
        if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      }
    }
  }
  return undefined;
}

export function extractPlaygroundVisitorRaw(route: unknown): string | undefined {
  if (!route || typeof route !== "object") return undefined;
  const headers =
    (route as { request?: { headers?: unknown }; headers?: unknown }).request?.headers ??
    (route as { headers?: unknown }).headers;
  if (!headers) return undefined;

  const explicitHeader = readHeaderCaseInsensitive(headers, "x-openclaw-playground-visitor");
  if (typeof explicitHeader === "string" && explicitHeader.trim().length > 0) {
    return explicitHeader.trim().slice(0, 512);
  }

  const cookieHeader = readHeaderCaseInsensitive(headers, "cookie");
  if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
    for (const part of cookieHeader.split(";")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = part.slice(0, eqIdx).trim();
      if (name !== "emdash_playground") continue;
      const rawVal = part.slice(eqIdx + 1).trim();
      if (!rawVal) continue;
      try {
        const decoded = decodeURIComponent(rawVal).trim();
        if (decoded) return decoded.slice(0, 512);
      } catch {
        return rawVal.slice(0, 512);
      }
    }
  }

  return undefined;
}

export async function hashPlaygroundVisitorId(rawVisitor: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawVisitor);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i]!.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 12);
}

export async function resolvePlaygroundVisitorHash(route: unknown): Promise<string | undefined> {
  const raw = extractPlaygroundVisitorRaw(route);
  if (!raw) return undefined;
  return await hashPlaygroundVisitorId(raw);
}

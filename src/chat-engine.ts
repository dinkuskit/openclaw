import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { getHostGatewayBridge } from "./gateway-bridge-registry.js";
import {
  PLAYGROUND_LOCKED_MESSAGE,
  extractRouteRuntimeEnv,
  isPlaygroundLocked,
  isSameGatewayOrigin,
  readPlaygroundEnvConfig,
  resolvePlaygroundConnection,
  resolvePlaygroundVisitorHash,
} from "./playground-env.js";
import {
  BLOBSTER_CATALOG_URL,
  BLOBSTER_SUBMIT_URL,
  FEATURED_AGENT_TEMPLATES,
  OPENCLAW_ENABLE_TEMPLATES_CMD,
  buildAgentTemplateInstallCommands,
  type AgentTemplateEntry,
  type AgentTemplateInstallCommands,
  type AutomationRule,
  type BoundEntryRef,
  type CatalogEntrySummary,
  type ChatTurnMessage,
  type ContentFieldDiff,
  type ConversationThread,
  type GatewayApprovalDecision,
  type GatewayBridgeStatus,
  type GatewayExecApproval,
  type OpenClawConnection,
  type OpenClawWorkspaceSnapshot,
  type ProposalLifecycleStatus,
  type RevisionProposal,
  type SiteCollectionSummary,
  type ToolCallTrace,
} from "./protocol.js";
import { publishOpenClawEvent, withOpenClawStorageLock } from "./sse-bus.js";

export {
  BLOBSTER_CATALOG_URL,
  BLOBSTER_SUBMIT_URL,
  FEATURED_AGENT_TEMPLATES,
  OPENCLAW_ENABLE_TEMPLATES_CMD,
  buildAgentTemplateInstallCommands,
  resolvePlaygroundVisitorHash,
  type AgentTemplateEntry,
  type AgentTemplateInstallCommands,
};

const EDITOR = 40;
const ADMIN = 50;
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Exclude SEO and live-publication metadata from initial draft-only operations
 * per architecture contract Section 5.
 */
const EXCLUDED_DRAFT_ONLY_FIELDS = new Set([
  "seoTitle",
  "seoDescription",
  "seoImage",
  "canonicalUrl",
  "noindex",
  "status",
  "publishedAt",
  "_rev",
  "id",
]);

interface RawContentItem {
  id: string;
  slug?: string;
  status?: string;
  locale?: string;
  version?: number;
  draftRevisionId?: string | null;
  liveRevisionId?: string | null;
  data?: Record<string, unknown>;
}

interface ExtendedPluginContext {
  schema?: {
    listCollections?: () => Promise<
      Array<{
        slug: string;
        label?: string;
        name?: string;
        supports?: string[];
        fields?: Array<{ name?: string; slug?: string; type?: string; label?: string }>;
      }>
    >;
    getCollection?: (slug: string) => Promise<{
      slug: string;
      label?: string;
      supports?: string[];
      fields?: Array<{ name?: string; slug?: string; type?: string; label?: string }>;
    } | null>;
  };
  content?: {
    list?: (
      collection: string,
      options?: { limit?: number; locale?: string },
    ) => Promise<{ items?: RawContentItem[] } | RawContentItem[]>;
    get?: (
      collection: string,
      id: string,
      options?: { locale?: string },
    ) => Promise<RawContentItem | null>;
    getRevision?: (
      collection: string,
      id: string,
      revisionId: string,
    ) => Promise<{ id: string; data?: Record<string, unknown> } | null>;
  };
}

function csprngId(prefix: string, byteLen = 10): string {
  const bytes = new Uint8Array(byteLen);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error("WebCrypto getRandomValues is required");
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

export function cleanInputText(value: unknown, max = 2000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\r\n?/g, "\n").trim();
  return trimmed.length > 0 &&
    trimmed.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(trimmed)
    ? trimmed
    : undefined;
}

export function resolveRequestOrigin(route: SandboxedRouteContext, ctx?: PluginContext): string {
  const reqUrl = (route as unknown as { request?: { url?: string } }).request?.url;
  if (typeof reqUrl === "string") {
    try {
      return new URL(reqUrl).origin;
    } catch {
      // ignore malformed URL
    }
  }
  const siteUrl = (ctx as unknown as { site?: { url?: string } } | undefined)?.site?.url;
  if (typeof siteUrl === "string" && siteUrl.startsWith("http")) {
    try {
      return new URL(siteUrl).origin;
    } catch {
      // ignore
    }
  }
  return "http://localhost:4321";
}

export function buildPairingCommandString(siteOrigin: string, pairingCode: string): string {
  return `curl -sS -X POST "${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair" -H "content-type: application/json" -d '{"pairingCode":"${pairingCode}","agentId":"openclaw","authorityMode":"propose_with_approval"}'`;
}

export function buildPairingPromptString(siteOrigin: string, pairingCode: string): string {
  const pairEndpoint = `${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair`;
  return [
    `Pair yourself with my EmDash CMS site (${siteOrigin})`,
    `using one-time pairing code: ${pairingCode}`,
    ``,
    `1. Run this curl command:`,
    `   ${buildPairingCommandString(siteOrigin, pairingCode)}`,
    `2. Authenticate follow-up MCP / REST requests with -H "X-OpenClaw-Token: <sessionToken>" (or JSON "sessionToken"; Authorization: Bearer <sessionToken> is also accepted on the native profile) at:`,
    `   ${pairEndpoint}`,
    `3. Poll native chat prompts with {"action":"poll_turn"} (or MCP emdash_status) and deliver replies with {"action":"complete_turn","turnId":"<turnId>","reply":"..."} (or MCP emdash_complete_turn).`,
  ].join("\n");
}

export async function getOrCreatePairingCode(ctx: PluginContext): Promise<string> {
  if (!ctx.kv) return csprngId("oc_pair_", 12);
  const existing = await ctx.kv.get("pairing_code");
  const expiresAt = await ctx.kv.get("pairing_code_expires_at");
  const validExpiry =
    typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > Date.now();
  if (typeof existing === "string" && existing.startsWith("oc_pair_") && validExpiry) {
    return existing;
  }
  const fresh = csprngId("oc_pair_", 12);
  await ctx.kv.set("pairing_code", fresh);
  await ctx.kv.set("pairing_code_expires_at", Date.now() + PAIRING_CODE_TTL_MS);
  return fresh;
}

export async function rotateSitePairingCode(ctx: PluginContext): Promise<string> {
  const fresh = csprngId("oc_pair_", 12);
  if (ctx.kv) {
    await ctx.kv.set("pairing_code", fresh);
    await ctx.kv.set("pairing_code_expires_at", Date.now() + PAIRING_CODE_TTL_MS);
  }
  return fresh;
}

function isSupportedGatewayUrl(url: string): boolean {
  return (
    url.startsWith("wss://") ||
    url.startsWith("https://") ||
    url.startsWith("ws://127.0.0.1:") ||
    url.startsWith("ws://localhost:") ||
    url.startsWith("ws://[::1]:") ||
    url.startsWith("http://127.0.0.1:") ||
    url.startsWith("http://localhost:")
  );
}

const PUBLIC_URL_SENSITIVE_QUERY_KEYS = [
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

export function sanitizePublicGatewayUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const key of PUBLIC_URL_SENSITIVE_QUERY_KEYS) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s"']+)@/gi, "$1");
  }
}

function validateDirectGatewayUrlInput(rawUrl: string): {
  ok: boolean;
  sanitizedUrl?: string;
  extractedToken?: string;
  extractedBootstrapToken?: string;
  error?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: "Invalid OpenClaw Gateway URL. Use ws://127.0.0.1:18789, wss://, or https://.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        "Gateway URL must not embed username or password credentials. Enter secrets in the Gateway token field.",
    };
  }
  const hostClean = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostClean === "127.0.0.1" || hostClean === "localhost" || hostClean === "::1";
  if ((parsed.protocol === "http:" || parsed.protocol === "ws:") && !isLoopback) {
    return {
      ok: false,
      error:
        "Plaintext ws:// / http:// is restricted to loopback (127.0.0.1 / localhost). Use wss:// or https:// for remote endpoints.",
    };
  }
  if (
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    return {
      ok: false,
      error: `Unsupported Gateway URL scheme "${parsed.protocol}". Use ws:// (loopback), wss://, or https://.`,
    };
  }
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const extractedToken =
    (hashParams.get("token") ?? parsed.searchParams.get("token") ?? "").trim() || undefined;
  const extractedBootstrapToken = !extractedToken
    ? (hashParams.get("bootstrapToken") ?? parsed.searchParams.get("bootstrapToken") ?? "").trim() ||
      undefined
    : undefined;
  return {
    ok: true,
    sanitizedUrl: sanitizePublicGatewayUrl(parsed.toString()),
    extractedToken,
    extractedBootstrapToken,
  };
}

function classifyTransportMode(
  gatewayUrl: string,
): "gateway-ws" | "live-gateway" | "paired-agent" {
  if (gatewayUrl === "https://agent-session.openclaw.local") {
    return "paired-agent";
  }
  if (gatewayUrl.startsWith("ws://") || gatewayUrl.startsWith("wss://")) {
    return "gateway-ws";
  }
  return "live-gateway";
}

export interface ConnectionSettingsReadState {
  connection: OpenClawConnection | null;
  error?: string;
  fromPlaygroundEnv?: boolean;
  playgroundLocked?: boolean;
}

export async function readConnectionSettingsState(
  ctx: PluginContext,
  extraEnv?: Record<string, unknown>,
): Promise<ConnectionSettingsReadState> {
  const playgroundCfg = readPlaygroundEnvConfig(extraEnv);
  const resolveEnvFallback = async (): Promise<OpenClawConnection | null> => {
    if (!playgroundCfg.gatewayUrl || !playgroundCfg.gatewayToken) {
      return null;
    }
    const fallbackSlugs = playgroundCfg.enabledCollections
      ? playgroundCfg.enabledCollections
      : (await listSiteCollections(ctx)).map(c => c.slug);
    return resolvePlaygroundConnection(fallbackSlugs, extraEnv);
  };

  if (playgroundCfg.locked && playgroundCfg.gatewayUrl && playgroundCfg.gatewayToken) {
    const envConn = await resolveEnvFallback();
    if (envConn) {
      return {
        connection: envConn,
        fromPlaygroundEnv: true,
        playgroundLocked: true,
      };
    }
  }

  let raw: unknown;
  let readError: string | undefined;
  try {
    raw = await ctx.settings.get("connection");
  } catch {
    readError =
      "Stored OpenClaw credentials could not be read (check EMDASH_ENCRYPTION_KEY or storage health). Existing encrypted settings were preserved.";
  }

  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<OpenClawConnection>;
      const hasStoredCredential =
        (typeof parsed.gatewayToken === "string" && parsed.gatewayToken.length > 0) ||
        (typeof parsed.bootstrapToken === "string" && parsed.bootstrapToken.length > 0) ||
        (typeof parsed.deviceToken === "string" && parsed.deviceToken.length > 0);
      if (
        typeof parsed.gatewayUrl === "string" &&
        isSupportedGatewayUrl(parsed.gatewayUrl) &&
        typeof parsed.agentId === "string" &&
        parsed.agentId.length > 0 &&
        typeof parsed.gatewayToken === "string" &&
        hasStoredCredential
      ) {
        return {
          connection: {
            gatewayUrl: parsed.gatewayUrl,
            agentId: parsed.agentId,
            gatewayToken: parsed.gatewayToken,
            ...(typeof parsed.bootstrapToken === "string" && parsed.bootstrapToken
              ? { bootstrapToken: parsed.bootstrapToken }
              : {}),
            ...(typeof parsed.deviceToken === "string" && parsed.deviceToken
              ? { deviceToken: parsed.deviceToken }
              : {}),
            ...(parsed.deviceIdentity &&
            typeof parsed.deviceIdentity.deviceId === "string" &&
            typeof parsed.deviceIdentity.publicKeyPem === "string" &&
            typeof parsed.deviceIdentity.privateKeyPem === "string"
              ? { deviceIdentity: parsed.deviceIdentity }
              : {}),
            authorityMode:
              parsed.authorityMode === "propose_with_approval"
                ? "propose_with_approval"
                : "read_only",
            allowGatewayExecApprovals: playgroundCfg.locked
              ? false
              : parsed.allowGatewayExecApprovals === true,
            ...(parsed.pairedAgentPoll === true ? { pairedAgentPoll: true } : {}),
            enabledCollections: Array.isArray(parsed.enabledCollections)
              ? parsed.enabledCollections.filter((item): item is string => typeof item === "string")
              : ["pages", "products"],
          },
          fromPlaygroundEnv: false,
          playgroundLocked: playgroundCfg.locked,
        };
      }
    } catch {
      // Preserve stored encrypted value instead of deleting on parse errors.
    }
    readError =
      "Stored OpenClaw connection settings could not be parsed. Re-save Gateway credentials to replace them.";
  }

  const envFallback = await resolveEnvFallback();
  if (envFallback) {
    return {
      connection: envFallback,
      fromPlaygroundEnv: true,
      playgroundLocked: playgroundCfg.locked,
    };
  }

  if (readError) {
    return {
      connection: null,
      error: readError,
      fromPlaygroundEnv: false,
      playgroundLocked: playgroundCfg.locked,
    };
  }
  return {
    connection: null,
    fromPlaygroundEnv: false,
    playgroundLocked: playgroundCfg.locked,
  };
}

export async function readConnectionSettings(
  ctx: PluginContext,
  extraEnv?: Record<string, unknown>,
): Promise<OpenClawConnection | null> {
  return (await readConnectionSettingsState(ctx, extraEnv)).connection;
}

async function persistConnectionSettings(
  ctx: PluginContext,
  next: OpenClawConnection,
): Promise<void> {
  const versioned = await ctx.settings.getVersioned("connection");
  await ctx.settings.compareAndSet(
    "connection",
    versioned?.revision ?? null,
    JSON.stringify(next),
  );
}

async function persistIssuedDeviceCredentials(
  ctx: PluginContext,
  expectedGatewayUrl: string,
  patch: {
    deviceIdentity?: OpenClawConnection["deviceIdentity"];
    deviceToken?: string;
    clearBootstrapToken?: boolean;
  },
): Promise<void> {
  const latestState = await readConnectionSettingsState(ctx);
  if (
    latestState.error ||
    !latestState.connection ||
    latestState.fromPlaygroundEnv ||
    latestState.playgroundLocked
  ) {
    return;
  }
  if (
    sanitizePublicGatewayUrl(latestState.connection.gatewayUrl) !==
    sanitizePublicGatewayUrl(expectedGatewayUrl)
  ) {
    return;
  }
  const next: OpenClawConnection = {
    ...latestState.connection,
    ...(patch.deviceIdentity ? { deviceIdentity: patch.deviceIdentity } : {}),
    ...(patch.deviceToken ? { deviceToken: patch.deviceToken } : {}),
  };
  if (patch.clearBootstrapToken) {
    delete next.bootstrapToken;
  }
  await persistConnectionSettings(ctx, next);
}

export async function listSiteCollections(
  ctx: PluginContext,
): Promise<SiteCollectionSummary[]> {
  const ext = ctx as unknown as ExtendedPluginContext;
  try {
    if (ext.schema?.listCollections) {
      const cols = await ext.schema.listCollections();
      if (Array.isArray(cols) && cols.length > 0) {
        return cols.map(col => {
          const supports = Array.isArray(col.supports)
            ? col.supports.filter((s): s is string => typeof s === "string")
            : undefined;
          return {
            slug: col.slug,
            label: col.label ?? col.name ?? col.slug,
            ...(supports
              ? { supports, supportsRevisions: supports.includes("revisions") }
              : {}),
          };
        });
      }
    }
  } catch {
    // Fall back to standard CMS collections.
  }
  return [
    { slug: "pages", label: "Pages" },
    { slug: "posts", label: "Posts" },
  ];
}

function canCollectionStageDraft(
  collections: SiteCollectionSummary[],
  collectionSlug: string,
  entryStatus?: string,
): boolean {
  const col = collections.find(c => c.slug === collectionSlug);
  if (!col || !Array.isArray(col.supports)) {
    return true;
  }
  if (col.supports.includes("revisions")) {
    return true;
  }
  return entryStatus === "draft" && col.supports.includes("drafts");
}

function summarizeItem(collection: string, raw: RawContentItem): CatalogEntrySummary {
  const data = raw.data && typeof raw.data === "object" ? raw.data : {};
  const titleCandidate =
    data.title ?? data.name ?? data.heading ?? data.label ?? raw.slug ?? raw.id;
  const title =
    typeof titleCandidate === "string" && titleCandidate.trim()
      ? titleCandidate.trim()
      : String(raw.slug ?? raw.id);

  const excerptCandidate =
    data.excerpt ??
    data.shortDescription ??
    data.summary ??
    data.subtitle ??
    (typeof data.description === "string" ? data.description : undefined);
  const excerpt =
    typeof excerptCandidate === "string" ? excerptCandidate.slice(0, 220) : undefined;

  let priceSummary: string | undefined;
  if (typeof data.price === "number") {
    priceSummary = `$${(data.price >= 100 && Number.isInteger(data.price) ? data.price / 100 : data.price).toFixed(2)}`;
  } else if (typeof data.priceCents === "number") {
    priceSummary = `$${(data.priceCents / 100).toFixed(2)}`;
  } else if (typeof data.price === "string" && data.price.trim()) {
    priceSummary = data.price.trim();
  }

  const syntheticVersionTag =
    typeof raw.version === "number"
      ? `v${raw.version}:${raw.draftRevisionId ?? raw.liveRevisionId ?? "head"}`
      : undefined;

  return {
    id: raw.id,
    collection,
    slug: raw.slug ?? raw.id,
    title,
    status: raw.status ?? "draft",
    locale: raw.locale,
    _rev: syntheticVersionTag,
    excerpt,
    priceSummary,
    fields: data,
  };
}

async function hydratePendingDraftRevision(
  ext: ExtendedPluginContext,
  collection: string,
  raw: RawContentItem,
): Promise<RawContentItem> {
  if (
    typeof raw.draftRevisionId !== "string" ||
    !raw.draftRevisionId ||
    raw.draftRevisionId === raw.liveRevisionId ||
    !ext.content?.getRevision
  ) {
    return raw;
  }
  try {
    const draftRev = await ext.content.getRevision(collection, raw.id, raw.draftRevisionId);
    if (!draftRev?.data || typeof draftRev.data !== "object") return raw;
    const cleanDraftData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draftRev.data)) {
      if (!k.startsWith("_")) cleanDraftData[k] = v;
    }
    return {
      ...raw,
      data: { ...(raw.data ?? {}), ...cleanDraftData },
    };
  } catch {
    return raw;
  }
}

async function listCollectionItems(
  ctx: PluginContext,
  collection: string,
  limit = 15,
): Promise<{ items: CatalogEntrySummary[]; durationMs: number }> {
  const start = Date.now();
  const ext = ctx as unknown as ExtendedPluginContext;
  if (!ext.content?.list) {
    return { items: [], durationMs: Date.now() - start };
  }
  try {
    const res = await ext.content.list(collection, { limit });
    const rawItems = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    const hydrated = await Promise.all(
      rawItems.map(item => hydratePendingDraftRevision(ext, collection, item)),
    );
    return {
      items: hydrated.map(item => summarizeItem(collection, item)),
      durationMs: Math.max(1, Date.now() - start),
    };
  } catch {
    return { items: [], durationMs: Math.max(1, Date.now() - start) };
  }
}

async function getSingleContentItem(
  ctx: PluginContext,
  collection: string,
  entryId: string,
  locale?: string,
): Promise<{
  item: CatalogEntrySummary | null;
  raw: RawContentItem | null;
  durationMs: number;
  hasContentGet: boolean;
}> {
  const start = Date.now();
  const ext = ctx as unknown as ExtendedPluginContext;
  if (!ext.content?.get) {
    return { item: null, raw: null, durationMs: Date.now() - start, hasContentGet: false };
  }
  try {
    const raw = await ext.content.get(collection, entryId, locale ? { locale } : undefined);
    const hydrated = raw ? await hydratePendingDraftRevision(ext, collection, raw) : null;
    return {
      item: hydrated ? summarizeItem(collection, hydrated) : null,
      raw: hydrated,
      durationMs: Math.max(1, Date.now() - start),
      hasContentGet: true,
    };
  } catch {
    return {
      item: null,
      raw: null,
      durationMs: Math.max(1, Date.now() - start),
      hasContentGet: true,
    };
  }
}

const MAX_PERSONAL_THREADS_PER_USER = 40;
const MAX_SHARED_THREADS = 80;
const MAX_TOTAL_THREADS = 240;

async function loadThreads(ctx: PluginContext): Promise<ConversationThread[]> {
  if (!ctx.kv) return [];
  const raw = await ctx.kv.get("chat_threads_v2");
  if (!Array.isArray(raw)) return [];
  return raw as ConversationThread[];
}

function retainThreads(
  threads: ConversationThread[],
  preserveIds: Iterable<string> = [],
): ConversationThread[] {
  const preserveSet = new Set(preserveIds);
  const deduped: ConversationThread[] = [];
  const seen = new Set<string>();
  for (const t of threads) {
    if (!t?.conversationId || seen.has(t.conversationId)) continue;
    seen.add(t.conversationId);
    deduped.push(t);
  }

  const isPinned = (t: ConversationThread) =>
    preserveSet.has(t.conversationId) ||
    t.status === "running" ||
    t.conversationId === "conv_default";

  const byUpdatedDesc = (a: ConversationThread, b: ConversationThread) =>
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

  const retainedIds = new Set<string>();
  const sharedBucket: ConversationThread[] = [];
  const personalBuckets = new Map<string, ConversationThread[]>();

  for (const t of deduped) {
    if (t.visibility === "shared" || !t.ownerUserId) {
      sharedBucket.push(t);
    } else {
      const list = personalBuckets.get(t.ownerUserId) ?? [];
      list.push(t);
      personalBuckets.set(t.ownerUserId, list);
    }
  }

  const keepFromBucket = (bucket: ConversationThread[], cap: number) => {
    const pinned = bucket.filter(isPinned);
    const rest = bucket.filter(t => !isPinned(t)).sort(byUpdatedDesc);
    for (const t of pinned) retainedIds.add(t.conversationId);
    for (const t of rest.slice(0, Math.max(0, cap - pinned.length))) {
      retainedIds.add(t.conversationId);
    }
  };

  keepFromBucket(sharedBucket, MAX_SHARED_THREADS);
  for (const bucket of personalBuckets.values()) {
    keepFromBucket(bucket, MAX_PERSONAL_THREADS_PER_USER);
  }

  const filtered = deduped.filter(t => retainedIds.has(t.conversationId));
  if (filtered.length <= MAX_TOTAL_THREADS) {
    return filtered;
  }

  const pinnedAll = filtered.filter(isPinned);
  const restAll = filtered.filter(t => !isPinned(t)).sort(byUpdatedDesc);
  const finalAllowed = new Set<string>([
    ...pinnedAll.map(t => t.conversationId),
    ...restAll
      .slice(0, Math.max(0, MAX_TOTAL_THREADS - pinnedAll.length))
      .map(t => t.conversationId),
  ]);
  return filtered.filter(t => finalAllowed.has(t.conversationId));
}

function isProposalUnresolved(status: ProposalLifecycleStatus): boolean {
  return status !== "applied" && status !== "rejected" && status !== "superseded";
}

async function collectProtectedConversationIds(ctx: PluginContext): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  if (ctx.kv) {
    const v2Proposals = normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"));
    for (const p of v2Proposals) {
      if (
        typeof p.conversationId === "string" &&
        p.conversationId &&
        isProposalUnresolved(p.status)
      ) {
        protectedIds.add(p.conversationId);
      }
    }
    const legacyPending = await ctx.kv.get("pending_proposals");
    if (Array.isArray(legacyPending)) {
      for (const item of legacyPending) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).conversationId === "string" &&
          ((item as Record<string, unknown>).conversationId as string).length > 0
        ) {
          protectedIds.add((item as Record<string, unknown>).conversationId as string);
        }
      }
    }
    const persistedApprovals = await ctx.kv.get("gateway_exec_approvals_v1");
    if (Array.isArray(persistedApprovals)) {
      for (const a of persistedApprovals as GatewayExecApproval[]) {
        if (a?.status === "pending" && typeof a.conversationId === "string" && a.conversationId) {
          protectedIds.add(a.conversationId);
        }
      }
    }
  }
  const bridge = getHostGatewayBridge();
  if (bridge) {
    for (const a of bridge.listLiveApprovals()) {
      if (a.status === "pending" && typeof a.conversationId === "string" && a.conversationId) {
        protectedIds.add(a.conversationId);
      }
    }
  }
  return protectedIds;
}

async function saveThreads(
  ctx: PluginContext,
  threads: ConversationThread[],
  preserveIds: Iterable<string> = [],
): Promise<ConversationThread[]> {
  const protectedIds = await collectProtectedConversationIds(ctx);
  for (const id of preserveIds) protectedIds.add(id);
  const retained = retainThreads(threads, protectedIds);
  if (ctx.kv) {
    await ctx.kv.set("chat_threads_v2", retained);
  }
  return retained;
}

async function mutateThreads<T>(
  ctx: PluginContext,
  preserveIds: Iterable<string>,
  mutator: (
    current: ConversationThread[],
    protectedIds: ReadonlySet<string>,
  ) =>
    | Promise<{ threads: ConversationThread[]; result: T }>
    | { threads: ConversationThread[]; result: T },
): Promise<T> {
  return await withOpenClawStorageLock("threads", async () => {
    const current = await loadThreads(ctx);
    const protectedIds = await collectProtectedConversationIds(ctx);
    for (const id of preserveIds) protectedIds.add(id);
    const { threads: next, result } = await mutator(current, protectedIds);
    await saveThreads(ctx, next, protectedIds);
    return result;
  });
}

function isThreadVisibleToUser(thread: ConversationThread, userId: string): boolean {
  if (thread.visibility === "shared") return true;
  if (!thread.ownerUserId) return true;
  return thread.ownerUserId === userId;
}

function isOwnedPersonalThread(thread: ConversationThread, userId: string): boolean {
  return (thread.visibility ?? "personal") === "personal" && thread.ownerUserId === userId;
}

function normalizeV2Proposals(rawV2: unknown): RevisionProposal[] {
  return Array.isArray(rawV2)
    ? (rawV2 as RevisionProposal[]).map(p => ({
        ...p,
        revisionNumber: typeof p.revisionNumber === "number" ? p.revisionNumber : 1,
      }))
    : [];
}

function checkProposalConnectionScope(
  connState: { connection: OpenClawConnection | null; error?: string },
  collection: string,
): Record<string, unknown> | null {
  if (connState.error) {
    return {
      ok: false,
      error: "SETTINGS_READ_ERROR",
      message: connState.error,
    };
  }
  const connection = connState.connection;
  if (!connection || connection.authorityMode !== "propose_with_approval") {
    return {
      ok: false,
      error: "AUTHORITY_READ_ONLY",
      message:
        "OpenClaw connection must be in propose_with_approval authority mode to revise or apply proposals.",
    };
  }
  if (!connection.enabledCollections.includes(collection)) {
    return {
      ok: false,
      error: "COLLECTION_NOT_ENABLED",
      message: `Collection "${collection}" is not enabled on the current OpenClaw connection.`,
    };
  }
  return null;
}

async function hydrateLegacyPendingProposal(
  ctx: PluginContext,
  item: Record<string, unknown>,
  fallbackIdx: number,
  connection: OpenClawConnection | null,
): Promise<RevisionProposal> {
  const proposalId =
    typeof item.proposalId === "string" ? item.proposalId : `prop_legacy_${fallbackIdx}`;
  const explicitCollection =
    typeof item.collection === "string" && item.collection.trim().length > 0
      ? item.collection.trim()
      : undefined;
  const collection = explicitCollection ?? "pages";
  const entryId = typeof item.entryId === "string" ? item.entryId : "current";
  const summary =
    typeof item.summary === "string" ? item.summary : "Proposed content change";

  const canImportConcretePatch = Boolean(
    connection &&
      connection.authorityMode === "propose_with_approval" &&
      explicitCollection &&
      connection.enabledCollections.includes(explicitCollection) &&
      entryId !== "current",
  );

  const proposedFields: Record<string, unknown> = {};
  if (canImportConcretePatch && item.proposedFields && typeof item.proposedFields === "object") {
    for (const [k, v] of Object.entries(item.proposedFields as Record<string, unknown>)) {
      if (!EXCLUDED_DRAFT_ONLY_FIELDS.has(k) && typeof v === "string") {
        proposedFields[k] = v;
      }
    }
  }

  let entrySlug = entryId;
  let entryTitle = entryId === "current" ? "External Agent Proposal" : entryId;
  let baseRev = "pending-browser-rev";
  let diffs: ContentFieldDiff[] = [
    {
      field: "summary",
      label: "External Summary (No Concrete Patch)",
      before: "(current saved content)",
      after: summary,
      addedLines: 0,
      removedLines: 0,
    },
  ];

  if (entryId !== "current") {
    const { item: stored } = await getSingleContentItem(ctx, collection, entryId);
    if (stored) {
      entrySlug = stored.slug;
      entryTitle = stored.title;
      if (stored._rev) baseRev = stored._rev;
    }
    if (Object.keys(proposedFields).length > 0) {
      diffs = Object.entries(proposedFields).map(([field, val]) => {
        const rawBefore = stored?.fields[field];
        const beforeVal =
          typeof rawBefore === "string"
            ? rawBefore
            : field === "title" || field === "name"
              ? (stored?.title ?? "")
              : "";
        return {
          field,
          label: field,
          before: beforeVal || "(empty)",
          after: String(val),
          ...countDiffLines(beforeVal, String(val)),
        };
      });
    }
  }

  return {
    proposalId,
    revisionNumber: 1,
    conversationId: "conv_default",
    agentId: typeof item.agentId === "string" ? item.agentId : "openclaw",
    collection,
    entryId,
    entrySlug,
    entryTitle,
    baseRev,
    summary,
    targetTool: typeof item.targetTool === "string" ? item.targetTool : "content:update",
    proposedFields: entryId === "current" ? {} : proposedFields,
    diffs,
    status: "pending",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function retainRevisionProposals(proposals: RevisionProposal[]): RevisionProposal[] {
  const deduped: RevisionProposal[] = [];
  const seen = new Set<string>();
  for (const p of proposals) {
    if (!p?.proposalId || seen.has(p.proposalId)) continue;
    seen.add(p.proposalId);
    deduped.push(p);
  }
  const unresolved = deduped.filter(p => isProposalUnresolved(p.status));
  const resolved = deduped.filter(p => !isProposalUnresolved(p.status));
  return [...unresolved, ...resolved.slice(0, Math.max(0, 80 - unresolved.length))];
}

export async function loadRevisionProposals(ctx: PluginContext): Promise<RevisionProposal[]> {
  if (!ctx.kv) return [];

  for (let pass = 0; pass < 3; pass++) {
    const legacySnapshot = await ctx.kv.get("pending_proposals");
    if (!Array.isArray(legacySnapshot) || legacySnapshot.length === 0) {
      return normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"));
    }

    const connState = await readConnectionSettingsState(ctx);
    const v2Snapshot = normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"));
    const knownIds = new Set(v2Snapshot.map(p => p.proposalId));
    const hydratedById = new Map<string, RevisionProposal>();

    for (let idx = 0; idx < legacySnapshot.length; idx++) {
      const rawItem = legacySnapshot[idx];
      if (!rawItem || typeof rawItem !== "object") continue;
      const rec = rawItem as Record<string, unknown>;
      const id = typeof rec.proposalId === "string" ? rec.proposalId : `prop_legacy_${idx}`;
      if (knownIds.has(id) || hydratedById.has(id)) continue;
      hydratedById.set(id, await hydrateLegacyPendingProposal(ctx, rec, idx, connState.connection));
    }

    const { merged, hasUnprocessed } = await withOpenClawStorageLock("proposals", async () => {
      const freshV2 = normalizeV2Proposals(await ctx.kv!.get("revision_proposals_v2"));
      const freshLegacyRaw = await ctx.kv!.get("pending_proposals");
      const freshLegacy = Array.isArray(freshLegacyRaw) ? freshLegacyRaw : [];
      const freshExistingIds = new Set(freshV2.map(p => p.proposalId));

      const toPrepend: RevisionProposal[] = [];
      for (const [id, built] of hydratedById) {
        if (!freshExistingIds.has(id)) {
          freshExistingIds.add(id);
          toPrepend.push(built);
        }
      }

      const nextV2 =
        toPrepend.length > 0 ? retainRevisionProposals([...toPrepend, ...freshV2]) : freshV2;
      if (toPrepend.length > 0) {
        await ctx.kv!.set("revision_proposals_v2", nextV2);
      }
      const retainedIds = new Set(nextV2.map(p => p.proposalId));

      const remainingLegacy = freshLegacy.filter((rawItem, idx) => {
        if (!rawItem || typeof rawItem !== "object") return false;
        const rec = rawItem as Record<string, unknown>;
        const id = typeof rec.proposalId === "string" ? rec.proposalId : `prop_legacy_${idx}`;
        return !retainedIds.has(id);
      });

      if (remainingLegacy.length === 0) {
        if (freshLegacy.length > 0) {
          await ctx.kv!.delete("pending_proposals");
        }
      } else {
        await ctx.kv!.set("pending_proposals", remainingLegacy);
      }

      return { merged: nextV2, hasUnprocessed: remainingLegacy.length > 0 };
    });

    if (!hasUnprocessed) {
      return merged;
    }
  }

  return normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"));
}

export async function saveRevisionProposals(
  ctx: PluginContext,
  proposals: RevisionProposal[],
): Promise<void> {
  if (!ctx.kv) return;
  await ctx.kv.set("revision_proposals_v2", retainRevisionProposals(proposals));
}

async function loadPersistedExecApprovals(ctx: PluginContext): Promise<GatewayExecApproval[]> {
  if (!ctx.kv) return [];
  const raw = await ctx.kv.get("gateway_exec_approvals_v1");
  return Array.isArray(raw) ? (raw as GatewayExecApproval[]) : [];
}

async function savePersistedExecApprovals(
  ctx: PluginContext,
  approvals: GatewayExecApproval[],
): Promise<void> {
  if (!ctx.kv) return;
  const pending = approvals.filter(a => a.status === "pending");
  const resolved = approvals.filter(a => a.status !== "pending");
  const retained = [...pending, ...resolved.slice(0, Math.max(0, 50 - pending.length))];
  await ctx.kv.set("gateway_exec_approvals_v1", retained);
}

async function upsertPersistedExecApprovals(
  ctx: PluginContext,
  incoming: GatewayExecApproval[],
): Promise<GatewayExecApproval[]> {
  if (incoming.length === 0) return await loadPersistedExecApprovals(ctx);
  return await withOpenClawStorageLock("approvals", async () => {
    const persisted = await loadPersistedExecApprovals(ctx);
    const byId = new Map<string, GatewayExecApproval>();
    for (const item of persisted) byId.set(item.approvalId, item);
    for (const item of incoming) byId.set(item.approvalId, item);
    const merged = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await savePersistedExecApprovals(ctx, merged);
    return merged;
  });
}

async function mergeExecApprovals(ctx: PluginContext): Promise<GatewayExecApproval[]> {
  const bridge = getHostGatewayBridge();
  const live = bridge ? bridge.listLiveApprovals() : [];
  if (live.length === 0) return await loadPersistedExecApprovals(ctx);
  return await upsertPersistedExecApprovals(ctx, live);
}

async function loadAutomations(
  ctx: PluginContext,
  collections: SiteCollectionSummary[],
): Promise<AutomationRule[]> {
  if (ctx.kv) {
    const saved = await ctx.kv.get("openclaw_automations_v1");
    if (Array.isArray(saved) && saved.length > 0) {
      return saved as AutomationRule[];
    }
  }
  const hasProducts = collections.some(c => c.slug === "products");
  const defaults: AutomationRule[] = [
    {
      automationId: "auto_copy_audit",
      name: hasProducts ? "Catalog Excerpt & Copy Audit" : "Draft Copy & Readability Audit",
      description:
        "Scans enabled collections for missing excerpts or thin descriptions and stages revision-fenced draft proposals.",
      schedule: "Weekdays · 08:00",
      collection: hasProducts ? "products" : (collections[0]?.slug ?? "pages"),
      enabled: true,
      lastRunSummary: "Ready · 0 unreviewed conflicts",
    },
    {
      automationId: "auto_draft_freshness",
      name: "Stale Draft Digest",
      description:
        "Summarizes unpublished EmDash drafts older than 14 days without modifying live storefront entries.",
      schedule: "Mondays · 09:00",
      collection: "pages",
      enabled: false,
    },
  ];
  if (ctx.kv) {
    await ctx.kv.set("openclaw_automations_v1", defaults);
  }
  return defaults;
}

function countDiffLines(before: string, after: string): { addedLines: number; removedLines: number } {
  const b = before.trim() ? before.split("\n").length : 0;
  const a = after.trim() ? after.split("\n").length : 0;
  return { addedLines: Math.max(1, a), removedLines: b };
}

function buildSmartFieldProposal(
  target: CatalogEntrySummary,
  prompt: string,
  conversationId: string,
  agentId: string,
  runId?: string,
  explicitFields?: Record<string, unknown>,
  explicitSummary?: string,
): RevisionProposal | null {
  const now = new Date().toISOString();
  const existingFields = target.fields ?? {};
  const proposedFields: Record<string, unknown> = {};
  const diffs: ContentFieldDiff[] = [];

  if (explicitFields && typeof explicitFields === "object") {
    for (const [field, value] of Object.entries(explicitFields)) {
      if (EXCLUDED_DRAFT_ONLY_FIELDS.has(field)) continue;
      if (!(field in existingFields) && field !== "title" && field !== "excerpt" && field !== "description") {
        continue;
      }
      if (typeof value !== "string") continue;
      const beforeVal =
        typeof existingFields[field] === "string" ? (existingFields[field] as string) : "";
      if (beforeVal === value) continue;
      proposedFields[field] = value;
      const counts = countDiffLines(beforeVal, value);
      diffs.push({
        field,
        label: field,
        before: beforeVal || "(empty)",
        after: value,
        ...counts,
      });
    }
    if (diffs.length === 0) return null;
  } else {
    // Draft-safe fields only (excluding SEO and publication status metadata)
    const textFieldCandidates = [
      "excerpt",
      "shortDescription",
      "subtitle",
      "tagline",
      "summary",
      "description",
      "title",
      "name",
    ];
    const presentStringFields = textFieldCandidates.filter(
      key =>
        !EXCLUDED_DRAFT_ONLY_FIELDS.has(key) &&
        key in existingFields &&
        (typeof existingFields[key] === "string" || existingFields[key] === null),
    );

    const quotedMatch = prompt.match(/(?:to|as|with)\s+["“]([^"”]{3,280})["”]/i);
    const wantsTitleChange = /\b(title|rename|name|heading)\b/i.test(prompt);

    if (wantsTitleChange && ("title" in existingFields || "name" in existingFields)) {
      const titleKey = "title" in existingFields ? "title" : "name";
      const beforeVal =
        typeof existingFields[titleKey] === "string"
          ? (existingFields[titleKey] as string)
          : target.title;
      const afterVal = quotedMatch?.[1] ?? `${beforeVal} — Studio Edition`;
      proposedFields[titleKey] = afterVal;
      const counts = countDiffLines(beforeVal, afterVal);
      diffs.push({
        field: titleKey,
        label: titleKey === "title" ? "Title" : "Name",
        before: beforeVal,
        after: afterVal,
        ...counts,
      });
    }

    const copyField =
      presentStringFields.find(k => k !== "title" && k !== "name") ??
      presentStringFields[0] ??
      ("title" in existingFields ? "title" : undefined);

    if (copyField && !(copyField in proposedFields)) {
      const beforeVal =
        typeof existingFields[copyField] === "string" ? (existingFields[copyField] as string) : "";
      const afterVal =
        quotedMatch && !wantsTitleChange
          ? quotedMatch[1]!
          : beforeVal
            ? `${beforeVal.replace(/\s*\(Refined.*?\)\s*$/i, "").trim()} — Refined for storefront clarity and conversion.`
            : `Crafted ${target.title} built for everyday reliability, crisp presentation, and effortless storefront discovery.`;
      proposedFields[copyField] = afterVal;
      const counts = countDiffLines(beforeVal, afterVal);
      diffs.push({
        field: copyField,
        label: copyField,
        before: beforeVal || "(empty)",
        after: afterVal,
        ...counts,
      });
    }

    if (diffs.length === 0) {
      proposedFields.title = quotedMatch?.[1] ?? `${target.title} (Draft Revision)`;
      diffs.push({
        field: "title",
        label: "Title",
        before: target.title,
        after: String(proposedFields.title),
        addedLines: 1,
        removedLines: 1,
      });
    }
  }

  return {
    proposalId: csprngId("prop_", 8),
    revisionNumber: 1,
    conversationId,
    runId,
    agentId,
    collection: target.collection,
    entryId: target.id,
    entrySlug: target.slug,
    entryTitle: target.title,
    locale: target.locale,
    baseRev: target._rev ?? "pending-browser-rev",
    summary:
      explicitSummary ??
      `Update ${diffs.map(d => d.field).join(", ")} on ${target.collection}/${target.slug}`,
    targetTool: "emdash.content.saveDraft",
    proposedFields,
    diffs,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Extracts structured ```emdash-proposal JSON blocks emitted by a live OpenClaw
 * Gateway agent and strips the raw fence from prose so only verified EmDash
 * RevisionProposal cards render actionable approval buttons.
 */
function parseGatewayAgentProposals(
  replyText: string,
  gatheredEntries: CatalogEntrySummary[],
  conversationId: string,
  agentId: string,
  runId?: string,
): { cleanedText: string; proposals: RevisionProposal[] } {
  const proposals: RevisionProposal[] = [];
  const fenceRegex = /```emdash-proposal\s*([\s\S]*?)```/gi;
  const cleanedText = replyText
    .replace(fenceRegex, (_full, jsonBody: string) => {
      try {
        const parsed = JSON.parse(jsonBody.trim()) as {
          collection?: string;
          entryId?: string;
          slug?: string;
          summary?: string;
          proposedFields?: Record<string, unknown>;
        };
        if (parsed && typeof parsed.proposedFields === "object" && parsed.proposedFields !== null) {
          const target = gatheredEntries.find(e => {
            if (parsed.collection && e.collection !== parsed.collection) return false;
            if (parsed.entryId) return e.id === parsed.entryId;
            if (parsed.slug) return e.slug === parsed.slug;
            return false;
          });
          if (target) {
            const built = buildSmartFieldProposal(
              target,
              "",
              conversationId,
              agentId,
              runId,
              parsed.proposedFields,
              typeof parsed.summary === "string" ? parsed.summary : undefined,
            );
            if (built) proposals.push(built);
          }
        }
      } catch {
        // Ignore malformed proposal JSON blocks.
      }
      return "";
    })
    .trim();

  return { cleanedText: cleanedText || replyText, proposals };
}

interface HttpGatewayTurnOptions {
  userRole: number;
  sessionKey: string;
  priorMessages: ChatTurnMessage[];
  systemContext: string;
  extraEnv?: Record<string, unknown>;
  fromPlaygroundEnv?: boolean;
}

interface HttpGatewayTurnResult {
  ok: boolean;
  replyText?: string;
  errorMessage?: string;
}

function isLoopbackHttpEndpoint(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function sanitizeHttpGatewayErrorMessage(raw: string): string {
  return raw
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(CF-Access-Client-Secret\s*:\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\boc_(?:live|sess|tok|pair|boot|dev)_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
}

async function tryExternalHttpGatewayTurn(
  ctx: PluginContext,
  connection: OpenClawConnection,
  prompt: string,
  options: HttpGatewayTurnOptions,
): Promise<HttpGatewayTurnResult> {
  // OpenClaw's `/v1/chat/completions` HTTP endpoint authenticates with the site's shared Gateway secret,
  // granting owner-sender semantics and full operator scopes. Restrict this transport to EmDash Administrators.
  if (options.userRole < ADMIN) {
    return {
      ok: false,
      errorMessage:
        "Administrator role is required to invoke an owner-authenticated HTTP(S) OpenClaw Gateway.",
    };
  }
  if (
    !connection.gatewayUrl ||
    connection.gatewayUrl === "https://agent-session.openclaw.local" ||
    connection.gatewayUrl.startsWith("ws://") ||
    connection.gatewayUrl.startsWith("wss://")
  ) {
    return {
      ok: false,
      errorMessage: "Configured Gateway URL is not an HTTP(S) completions endpoint.",
    };
  }
  const base = connection.gatewayUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/chat/completions")
    ? base
    : `${base}/v1/chat/completions`;
  const playgroundCfg = readPlaygroundEnvConfig(options.extraEnv);
  const isTrustedPlaygroundOrigin = Boolean(
    options.fromPlaygroundEnv ||
      (playgroundCfg.gatewayUrl && isSameGatewayOrigin(endpoint, playgroundCfg.gatewayUrl)),
  );
  // EmDash's host `ctx.http.fetch` wrapper rejects loopback targets (`127.0.0.1` / `localhost` / `[::1]`)
  // as non-public IPs. Use `globalThis.fetch` directly for loopback gateways and server-configured
  // `OPENCLAW_PLAYGROUND_GATEWAY_URL`, while keeping `ctx.http.fetch` first for non-loopback user URLs.
  const bypassHostHttpGuard = isLoopbackHttpEndpoint(endpoint) || isTrustedPlaygroundOrigin;
  const globalFetch =
    typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  const ctxFetch = ctx?.http?.fetch ? ctx.http.fetch.bind(ctx.http) : null;
  const httpFetch = bypassHostHttpGuard ? (globalFetch ?? ctxFetch) : (ctxFetch ?? globalFetch);
  if (!httpFetch) {
    return {
      ok: false,
      errorMessage:
        "HTTP client capability (`ctx.http` / `globalThis.fetch`) is unavailable in this runtime.",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${connection.gatewayToken}`,
    "x-openclaw-agent-id": connection.agentId,
    "x-openclaw-scopes": "operator.write",
    "x-openclaw-session-key": options.sessionKey,
  };
  if (
    playgroundCfg.cfAccessClientId &&
    playgroundCfg.cfAccessClientSecret &&
    (!playgroundCfg.gatewayUrl || isSameGatewayOrigin(endpoint, playgroundCfg.gatewayUrl))
  ) {
    headers["CF-Access-Client-Id"] = playgroundCfg.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = playgroundCfg.cfAccessClientSecret;
  }

  const historyMessages = options.priorMessages
    .filter(
      m =>
        (m.role === "user" || m.role === "assistant") &&
        m.status !== "streaming" &&
        m.status !== "failed" &&
        m.content.trim().length > 0,
    )
    .slice(-20)
    .map(m => ({
      role: m.role,
      content: m.content,
    }));

  try {
    const response = await httpFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: `openclaw/${connection.agentId}`,
        user: options.sessionKey,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              `You are @${connection.agentId}, connected to an EmDash CMS store (${connection.authorityMode}). ` +
              `Ground every answer strictly in the live EmDash collections below:\n${options.systemContext}`,
          },
          ...historyMessages,
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        errorMessage: `HTTP Gateway returned status ${response.status}.`,
      };
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      reply?: string;
    };
    const content = json.choices?.[0]?.message?.content ?? json.reply;
    if (typeof content === "string" && content.trim()) {
      return { ok: true, replyText: content.trim() };
    }
    return {
      ok: false,
      errorMessage: "HTTP Gateway returned an empty completion response.",
    };
  } catch (err) {
    return {
      ok: false,
      errorMessage:
        err instanceof Error
          ? sanitizeHttpGatewayErrorMessage(err.message)
          : "HTTP Gateway request failed.",
    };
  }
}

function normalizeOpenClawAgentSegment(agentId: string | undefined | null): string {
  const normalized = (agentId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return normalized || "openclaw";
}

function parseSessionKeyAgentSegment(sessionKey: string | undefined | null): string | undefined {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return undefined;
  const match = /^agent:([^:]+):(.+)$/i.exec(raw);
  if (!match || !match[1] || !match[2]) return undefined;
  return normalizeOpenClawAgentSegment(match[1]);
}

function buildCanonicalSessionKey(
  agentId: string,
  conversationId: string,
  visitorHash?: string,
): string {
  const safeAgent = normalizeOpenClawAgentSegment(agentId);
  const safeConv = conversationId.replace(/[^a-zA-Z0-9_-]/g, "");
  const scopeSegment = visitorHash ? `pg-${visitorHash}` : "emdash";
  return `agent:${safeAgent}:${scopeSegment}:${safeConv}`;
}

function resolveThreadSessionKey(
  thread: Pick<ConversationThread, "conversationId" | "sessionKey" | "agentSessionKeys">,
  agentId: string,
  visitorHash?: string,
): string {
  const targetAgent = normalizeOpenClawAgentSegment(agentId);
  if (visitorHash) {
    const expectedPrefix = `agent:${targetAgent}:pg-${visitorHash}:`;
    if (thread.sessionKey && thread.sessionKey.startsWith(expectedPrefix)) {
      return thread.sessionKey;
    }
    return buildCanonicalSessionKey(targetAgent, thread.conversationId, visitorHash);
  }
  if (
    thread.sessionKey &&
    parseSessionKeyAgentSegment(thread.sessionKey) === targetAgent &&
    !thread.sessionKey.startsWith(`agent:${targetAgent}:pg-`)
  ) {
    return thread.sessionKey;
  }
  const remembered = thread.agentSessionKeys?.[targetAgent];
  if (
    remembered &&
    parseSessionKeyAgentSegment(remembered) === targetAgent &&
    !remembered.startsWith(`agent:${targetAgent}:pg-`)
  ) {
    return remembered;
  }
  return buildCanonicalSessionKey(targetAgent, thread.conversationId);
}

function bindThreadToAgentSession(
  thread: ConversationThread,
  agentId: string,
  explicitSessionKey?: string,
  visitorHash?: string,
): ConversationThread {
  const targetAgent = normalizeOpenClawAgentSegment(agentId);
  const sessionKey =
    explicitSessionKey ?? resolveThreadSessionKey(thread, targetAgent, visitorHash);
  const existingAgent = parseSessionKeyAgentSegment(thread.sessionKey);
  const nextMap: Record<string, string> = {
    ...(thread.agentSessionKeys ?? {}),
    ...(thread.sessionKey && existingAgent ? { [existingAgent]: thread.sessionKey } : {}),
    [targetAgent]: sessionKey,
  };
  return {
    ...thread,
    sessionKey,
    agentSessionKeys: nextMap,
  };
}

function formatPriorConversationContext(messages: ChatTurnMessage[]): string {
  const completed = messages
    .filter(
      m =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0 &&
        m.status !== "streaming",
    )
    .slice(-12);
  if (completed.length === 0) return "";
  const lines = completed.map(
    m => `[${m.role === "user" ? "User" : "Assistant"}]: ${m.content.trim().slice(0, 1200)}`,
  );
  return `\n\n<prior_conversation_transcript>\n${lines.join("\n\n")}\n</prior_conversation_transcript>`;
}

function ensureUserThreads(
  allThreads: ConversationThread[],
  currentUserId: string,
  agentId: string,
  collections: SiteCollectionSummary[],
  entriesPreview: CatalogEntrySummary[],
  boundEntry?: BoundEntryRef,
  visitorHash?: string,
): { threads: ConversationThread[]; addedIds: string[]; reboundIds: string[] } {
  const reboundIds: string[] = [];
  let next = allThreads.map(t => {
    if (t.status === "running") return t;
    const expectedKey = resolveThreadSessionKey(t, agentId, visitorHash);
    if (t.sessionKey === expectedKey) return t;
    reboundIds.push(t.conversationId);
    return bindThreadToAgentSession(t, agentId, expectedKey, visitorHash);
  });
  const addedIds: string[] = [];

  if (boundEntry) {
    const existingBound = next.find(
      t =>
        isOwnedPersonalThread(t, currentUserId) &&
        t.boundEntry?.collection === boundEntry.collection &&
        t.boundEntry?.entryId === boundEntry.entryId,
    );
    if (!existingBound) {
      const now = new Date().toISOString();
      const matched = entriesPreview.find(
        e => e.collection === boundEntry.collection && e.id === boundEntry.entryId,
      );
      const baseConvId = `conv_entry_${currentUserId}_${boundEntry.collection}_${boundEntry.entryId}`;
      const convId = next.some(t => t.conversationId === baseConvId)
        ? `${baseConvId}_${csprngId("", 3)}`
        : baseConvId;
      const sessionKey = buildCanonicalSessionKey(agentId, convId, visitorHash);
      const targetAgent = normalizeOpenClawAgentSegment(agentId);
      addedIds.push(convId);
      next = [
        {
          conversationId: convId,
          ownerUserId: currentUserId,
          visibility: "personal",
          sessionKey,
          agentSessionKeys: { [targetAgent]: sessionKey },
          title:
            boundEntry.title ?? matched?.title ?? `${boundEntry.collection}/${boundEntry.entryId}`,
          scopeGroup: "editor entries",
          boundEntry: {
            ...boundEntry,
            title: boundEntry.title ?? matched?.title,
            slug: boundEntry.slug ?? matched?.slug,
          },
          status: "idle",
          createdAt: now,
          updatedAt: now,
          messages: [],
        },
        ...next,
      ];
    }
  }

  const ownedPersonal = next.filter(t => isOwnedPersonalThread(t, currentUserId));
  if (ownedPersonal.length === 0) {
    const now = new Date().toISOString();
    const hasProducts = collections.some(c => c.slug === "products");
    const baseConvId =
      currentUserId === "u1" || currentUserId === "dev-admin"
        ? "conv_catalog_overview"
        : `conv_${currentUserId}_overview`;
    const convId = next.some(t => t.conversationId === baseConvId)
      ? `conv_${currentUserId}_personal_${csprngId("", 3)}`
      : baseConvId;
    const sessionKey = buildCanonicalSessionKey(agentId, convId, visitorHash);
    const targetAgent = normalizeOpenClawAgentSegment(agentId);
    addedIds.push(convId);
    next = [
      {
        conversationId: convId,
        ownerUserId: currentUserId,
        visibility: "personal",
        sessionKey,
        agentSessionKeys: { [targetAgent]: sessionKey },
        title: hasProducts ? "Catalog & Products Overview" : "Site Content Overview",
        scopeGroup: hasProducts ? "products" : "pages & storefront",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
      ...next,
    ];
  }
  return { threads: next, addedIds, reboundIds };
}

export async function buildWorkspaceSnapshot(
  route: SandboxedRouteContext,
  ctx: PluginContext,
  preferredConversationId?: string,
  boundEntry?: BoundEntryRef,
): Promise<OpenClawWorkspaceSnapshot> {
  const userRole = route.user?.role ?? 0;
  const currentUserId = route.user?.id || "anonymous";
  const isAdmin = userRole >= ADMIN;
  const siteOrigin = resolveRequestOrigin(route, ctx);
  const siteName =
    (ctx as unknown as { site?: { name?: string } }).site?.name ?? "EmDash Store";
  const extraEnv = extractRouteRuntimeEnv(route) ?? extractRouteRuntimeEnv(ctx);
  const visitorHash = await resolvePlaygroundVisitorHash(route);
  const connState = await readConnectionSettingsState(ctx, extraEnv);
  const connection = connState.connection;
  const playgroundLocked = Boolean(connState.playgroundLocked);
  const playgroundMode = Boolean(connState.fromPlaygroundEnv || playgroundLocked);
  const pairingCode = isAdmin && !playgroundLocked ? await getOrCreatePairingCode(ctx) : "";
  const collections = await listSiteCollections(ctx);

  const visibleSlugs = connection
    ? collections.filter(c => connection.enabledCollections.includes(c.slug)).map(c => c.slug)
    : collections.map(c => c.slug);

  const entriesPreview: CatalogEntrySummary[] = [];
  const enrichedCollections: SiteCollectionSummary[] = [];

  for (const col of collections) {
    if (visibleSlugs.includes(col.slug)) {
      const { items } = await listCollectionItems(ctx, col.slug, 12);
      enrichedCollections.push({ ...col, entryCount: items.length });
      entriesPreview.push(...items);
    } else {
      enrichedCollections.push(col);
    }
  }

  const agentId = connection?.agentId ?? "openclaw";
  let allThreads = await loadThreads(ctx);
  const initialEnsure = ensureUserThreads(
    allThreads,
    currentUserId,
    agentId,
    enrichedCollections,
    entriesPreview,
    boundEntry,
    visitorHash,
  );
  if (initialEnsure.addedIds.length > 0 || initialEnsure.reboundIds.length > 0) {
    allThreads = await mutateThreads(
      ctx,
      [...initialEnsure.addedIds, ...initialEnsure.reboundIds],
      (current, protectedIds) => {
        const reEnsured = ensureUserThreads(
          current,
          currentUserId,
          agentId,
          enrichedCollections,
          entriesPreview,
          boundEntry,
          visitorHash,
        );
        const retained = retainThreads(reEnsured.threads, [
          ...protectedIds,
          ...initialEnsure.addedIds,
          ...initialEnsure.reboundIds,
          ...reEnsured.addedIds,
          ...reEnsured.reboundIds,
        ]);
        return { threads: retained, result: retained };
      },
    );
  }

  const visibleThreads = allThreads.filter(t => isThreadVisibleToUser(t, currentUserId));
  const visibleConvIds = new Set(visibleThreads.map(t => t.conversationId));

  const allProposals = await loadRevisionProposals(ctx);
  const visibleProposals = allProposals.filter(
    p => visibleConvIds.has(p.conversationId) || p.conversationId === "conv_default",
  );

  const allExecApprovals = await mergeExecApprovals(ctx);
  const visibleApprovals = allExecApprovals.filter(
    a =>
      visibleConvIds.has(a.conversationId) ||
      (isAdmin && a.conversationId === "conv_catalog_overview"),
  );

  const automations = await loadAutomations(ctx, enrichedCollections);

  let activeConversationId = preferredConversationId;
  if (boundEntry && !activeConversationId) {
    activeConversationId = visibleThreads.find(
      t =>
        isOwnedPersonalThread(t, currentUserId) &&
        t.boundEntry?.collection === boundEntry.collection &&
        t.boundEntry?.entryId === boundEntry.entryId,
    )?.conversationId;
  }
  if (
    !activeConversationId ||
    !visibleThreads.some(t => t.conversationId === activeConversationId)
  ) {
    activeConversationId =
      visibleThreads.find(t => isOwnedPersonalThread(t, currentUserId))?.conversationId ??
      visibleThreads[0]!.conversationId;
  }

  const bridge = getHostGatewayBridge();
  const transportMode = connection ? classifyTransportMode(connection.gatewayUrl) : null;
  const gatewayBridge: GatewayBridgeStatus =
    connState.fromPlaygroundEnv && connection && transportMode === "live-gateway"
      ? {
          available: true,
          state: "connected",
          gatewayUrl: sanitizePublicGatewayUrl(connection.gatewayUrl),
          grantedScopes: ["operator.write"],
        }
      : bridge
        ? bridge.getStatus(connection)
        : {
            available: false,
            state: "disconnected",
            grantedScopes: [],
          };

  const canResolveGatewayApprovals =
    isAdmin &&
    !playgroundLocked &&
    Boolean(connection?.allowGatewayExecApprovals) &&
    gatewayBridge.grantedScopes.includes("operator.approvals");

  return {
    ok: true,
    currentUserId,
    isAdmin,
    userRole,
    canResolveGatewayApprovals,
    siteOrigin,
    siteName,
    paired: Boolean(connection),
    pairingCode,
    pairingCommand:
      isAdmin && !playgroundLocked ? buildPairingCommandString(siteOrigin, pairingCode) : "",
    pairingPrompt:
      isAdmin && !playgroundLocked ? buildPairingPromptString(siteOrigin, pairingCode) : "",
    ...(connState.error ? { settingsError: connState.error } : {}),
    connection: connection
      ? {
          gatewayUrl: sanitizePublicGatewayUrl(connection.gatewayUrl),
          agentId: connection.agentId,
          authorityMode: connection.authorityMode,
          allowGatewayExecApprovals: Boolean(connection.allowGatewayExecApprovals),
          enabledCollections: connection.enabledCollections,
          transportMode: transportMode ?? classifyTransportMode(connection.gatewayUrl),
        }
      : null,
    gatewayBridge,
    collections: enrichedCollections,
    entriesPreview,
    threads: visibleThreads,
    activeConversationId,
    proposals: visibleProposals,
    execApprovals: visibleApprovals,
    automations,
    agentTemplates: FEATURED_AGENT_TEMPLATES,
    catalogUrl: BLOBSTER_CATALOG_URL,
    submitUrl: BLOBSTER_SUBMIT_URL,
    playgroundMode,
    playgroundLocked,
    streamEndpoint: "/_emdash/api/openclaw/stream",
  };
}

/**
 * Verifies against EmDash `ctx.content.get` whether a proposal's `proposedFields`
 * are actually present on the stored entry so receipts cannot be spoofed and
 * interrupted network responses (`outcome_unknown`) reconcile deterministically.
 */
async function verifyFieldsOnStoredEntry(
  ctx: PluginContext,
  proposal: RevisionProposal,
): Promise<{ checked: boolean; matches: boolean }> {
  const fieldEntries = Object.entries(proposal.proposedFields ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (fieldEntries.length === 0 || proposal.entryId === "current") {
    return { checked: true, matches: false };
  }
  const ext = ctx as unknown as ExtendedPluginContext;
  const { item, raw, hasContentGet } = await getSingleContentItem(
    ctx,
    proposal.collection,
    proposal.entryId,
    proposal.locale,
  );
  if (!hasContentGet) {
    return { checked: false, matches: true };
  }
  if (!item) {
    return { checked: true, matches: false };
  }
  for (const [key, expectedVal] of fieldEntries) {
    if (item.fields[key] !== expectedVal) {
      if (
        !ext.content?.getRevision &&
        raw?.status === "published" &&
        typeof raw.draftRevisionId === "string" &&
        raw.draftRevisionId &&
        raw.draftRevisionId !== raw.liveRevisionId
      ) {
        return { checked: false, matches: true };
      }
      return { checked: true, matches: false };
    }
  }
  return { checked: true, matches: true };
}

function resolveThreadAudience(
  threads: ConversationThread[],
  conversationId: string,
  fallbackUserId: string,
): { ownerUserId?: string; visibility: "personal" | "shared" } {
  if (conversationId === "conv_default") {
    return { visibility: "shared" };
  }
  const thread = threads.find(t => t.conversationId === conversationId);
  if (!thread) {
    return { ownerUserId: fallbackUserId, visibility: "personal" };
  }
  return {
    ownerUserId: thread.ownerUserId ?? fallbackUserId,
    visibility: thread.visibility ?? "personal",
  };
}

async function doesStoredEntryMatchProposalBase(
  ctx: PluginContext,
  proposal: RevisionProposal,
): Promise<{ checked: boolean; matches: boolean; item: CatalogEntrySummary | null }> {
  const { item, hasContentGet } = await getSingleContentItem(
    ctx,
    proposal.collection,
    proposal.entryId,
    proposal.locale,
  );
  if (!hasContentGet) {
    return { checked: false, matches: true, item: null };
  }
  if (!item) {
    return { checked: true, matches: false, item: null };
  }
  if (proposal.baseRev.startsWith("v") && item._rev && item._rev !== proposal.baseRev) {
    return { checked: true, matches: false, item };
  }
  for (const d of proposal.diffs) {
    if (d.before === "(current saved content)") continue;
    const rawVal = item.fields[d.field];
    const storedVal =
      typeof rawVal === "string"
        ? rawVal
        : d.field === "title" || d.field === "name"
          ? item.title
          : "";
    const expectedVal = d.before === "(empty)" ? "" : d.before;
    if (storedVal !== expectedVal) {
      return { checked: true, matches: false, item };
    }
  }
  return { checked: true, matches: true, item };
}

export interface PairedAgentTurnRecord {
  turnId: string;
  conversationId: string;
  assistantMessageId: string;
  sessionKey: string;
  agentId: string;
  ownerUserId?: string;
  visibility: "personal" | "shared";
  requestedByUserId: string;
  requestedByRole: number;
  prompt: string;
  steers?: string[];
  systemContext: string;
  gatheredSnapshot?: CatalogEntrySummary[];
  status: "running" | "steered" | "completed" | "stopped";
  lastUpdate: string;
  createdAt: string;
}

export interface PolledPairedAgentTurn {
  turnId: string;
  conversationId?: string;
  sessionKey?: string;
  requestedByRole?: number;
  prompt: string;
  steers?: string[];
  systemContext?: string;
  status: "running" | "steered" | "completed" | "stopped";
  lastUpdate: string;
}

const MAX_ACTIVE_PAIRED_TURNS = 50;
const MAX_TERMINAL_PAIRED_TURNS = 16;

function normalizePairedAgentTurns(raw: unknown): PairedAgentTurnRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PairedAgentTurnRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<PairedAgentTurnRecord>;
    if (
      typeof rec.turnId !== "string" ||
      typeof rec.conversationId !== "string" ||
      typeof rec.assistantMessageId !== "string" ||
      typeof rec.prompt !== "string"
    ) {
      continue;
    }
    const status =
      rec.status === "steered" || rec.status === "completed" || rec.status === "stopped"
        ? rec.status
        : "running";
    out.push({
      turnId: rec.turnId,
      conversationId: rec.conversationId,
      assistantMessageId: rec.assistantMessageId,
      sessionKey: typeof rec.sessionKey === "string" ? rec.sessionKey : `agent:openclaw:emdash:${rec.conversationId}`,
      agentId: typeof rec.agentId === "string" ? rec.agentId : "openclaw",
      ...(typeof rec.ownerUserId === "string" ? { ownerUserId: rec.ownerUserId } : {}),
      visibility: rec.visibility === "shared" ? "shared" : "personal",
      requestedByUserId: typeof rec.requestedByUserId === "string" ? rec.requestedByUserId : "u1",
      requestedByRole: typeof rec.requestedByRole === "number" ? rec.requestedByRole : EDITOR,
      prompt: rec.prompt,
      ...(Array.isArray(rec.steers)
        ? { steers: rec.steers.filter((s): s is string => typeof s === "string") }
        : {}),
      systemContext: typeof rec.systemContext === "string" ? rec.systemContext : "",
      ...(Array.isArray(rec.gatheredSnapshot) ? { gatheredSnapshot: rec.gatheredSnapshot } : {}),
      status,
      lastUpdate: typeof rec.lastUpdate === "string" ? rec.lastUpdate : "",
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
    });
  }
  return out;
}

function prunePairedAgentTurns(records: PairedAgentTurnRecord[]): PairedAgentTurnRecord[] {
  const active = records.filter(r => r.status === "running" || r.status === "steered");
  const terminal = records
    .filter(r => r.status === "completed" || r.status === "stopped")
    .slice(-MAX_TERMINAL_PAIRED_TURNS);
  return [...terminal, ...active];
}

function projectPolledTurn(rec: PairedAgentTurnRecord): PolledPairedAgentTurn {
  return {
    turnId: rec.turnId,
    conversationId: rec.conversationId,
    sessionKey: rec.sessionKey,
    requestedByRole: rec.requestedByRole,
    prompt: rec.prompt,
    ...(rec.steers && rec.steers.length > 0 ? { steers: rec.steers } : {}),
    systemContext: rec.systemContext,
    status: rec.status,
    lastUpdate: rec.lastUpdate,
  };
}

function isPairedRecordVisibleToViewer(
  rec: PairedAgentTurnRecord,
  threads: ConversationThread[],
  viewerUserId: string,
): boolean {
  const thread = threads.find(t => t.conversationId === rec.conversationId);
  if (thread) {
    return isThreadVisibleToUser(thread, viewerUserId);
  }
  return rec.visibility === "shared" || rec.ownerUserId === viewerUserId;
}

async function enqueuePairedAgentTurn(
  ctx: PluginContext,
  record: PairedAgentTurnRecord,
): Promise<{ queued: boolean; error?: string }> {
  if (!ctx.kv) {
    return {
      queued: false,
      error: "Plugin KV storage is unavailable to queue paired-agent turns.",
    };
  }
  return withOpenClawStorageLock("paired_turns", async () => {
    const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
    const activeCount = existing.filter(
      r => r.status === "running" || r.status === "steered",
    ).length;
    if (activeCount >= MAX_ACTIVE_PAIRED_TURNS) {
      return {
        queued: false,
        error: `Paired agent queue already has ${MAX_ACTIVE_PAIRED_TURNS} pending turns. Wait for your paired OpenClaw agent to poll or stop stalled turns.`,
      };
    }
    const updated = prunePairedAgentTurns([...existing, record]);
    await ctx.kv!.set("paired_agent_turns_v1", updated);
    return { queued: true };
  });
}

export async function steerPairedAgentTurn(
  ctx: PluginContext,
  conversationId: string | undefined,
  steerPrompt: string,
  viewerUserId?: string,
): Promise<PairedAgentTurnRecord | null> {
  if (!ctx.kv) return null;
  return withOpenClawStorageLock("paired_turns", async () => {
    const threads = viewerUserId ? await loadThreads(ctx) : [];
    const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
    const targetIdx = existing.findIndex(
      r =>
        (r.status === "running" || r.status === "steered") &&
        (!conversationId || r.conversationId === conversationId) &&
        (!viewerUserId || isPairedRecordVisibleToViewer(r, threads, viewerUserId)),
    );
    if (targetIdx === -1) return null;
    const target = existing[targetIdx]!;
    const steered: PairedAgentTurnRecord = {
      ...target,
      steers: [...(target.steers ?? []), steerPrompt],
      status: "steered",
      lastUpdate: `Queued mid-task steer: "${steerPrompt}"`,
    };
    const updated = existing.map((r, i) => (i === targetIdx ? steered : r));
    await ctx.kv!.set("paired_agent_turns_v1", updated);
    return steered;
  });
}

export async function stopPairedAgentTurns(
  ctx: PluginContext,
  conversationId: string,
  viewerUserId?: string,
): Promise<string[]> {
  if (!ctx.kv || !conversationId) return [];
  return withOpenClawStorageLock("paired_turns", async () => {
    const threads = viewerUserId ? await loadThreads(ctx) : [];
    const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
    const stoppedIds = new Set<string>();
    const updated = prunePairedAgentTurns(
      existing.map(r => {
        if (
          (r.status === "running" || r.status === "steered") &&
          r.conversationId === conversationId &&
          (!viewerUserId || isPairedRecordVisibleToViewer(r, threads, viewerUserId))
        ) {
          stoppedIds.add(r.turnId);
          return {
            ...r,
            status: "stopped" as const,
            gatheredSnapshot: undefined,
            lastUpdate: "Stopped by operator in EmDash.",
          };
        }
        return r;
      }),
    );
    if (stoppedIds.size > 0) {
      await ctx.kv!.set("paired_agent_turns_v1", updated);
    }
    return [...stoppedIds];
  });
}

export async function cancelAllPairedAgentTurns(
  ctx: PluginContext,
  reasonMessage: string,
): Promise<void> {
  const activeRecords = ctx.kv
    ? await withOpenClawStorageLock("paired_turns", async () => {
        const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
        const cancelled: PairedAgentTurnRecord[] = [];
        const updated = prunePairedAgentTurns(
          existing.map(r => {
            if (r.status === "running" || r.status === "steered") {
              cancelled.push(r);
              return {
                ...r,
                status: "stopped" as const,
                gatheredSnapshot: undefined,
                lastUpdate: reasonMessage,
              };
            }
            return r;
          }),
        );
        if (cancelled.length > 0) {
          await ctx.kv!.set("paired_agent_turns_v1", updated);
        }
        await ctx.kv!.delete("active_turn");
        return cancelled;
      })
    : [];

  if (activeRecords.length === 0) return;
  const affectedConvIds = [...new Set(activeRecords.map(r => r.conversationId))];
  const cancelledMsgIds = new Set(activeRecords.map(r => r.assistantMessageId));

  const updatedThreads = await mutateThreads(ctx, affectedConvIds, current => {
    const next = current.map(t => {
      if (!affectedConvIds.includes(t.conversationId)) return t;
      const messages = t.messages.map(m =>
        cancelledMsgIds.has(m.messageId) && m.status === "streaming"
          ? { ...m, content: m.content || reasonMessage, status: "failed" as const }
          : m,
      );
      const stillStreaming = messages.some(m => m.status === "streaming");
      return {
        ...t,
        status: stillStreaming ? ("running" as const) : ("failed" as const),
        ...(stillStreaming ? {} : { activeRunId: undefined, runPhase: undefined }),
        updatedAt: new Date().toISOString(),
        messages,
      };
    });
    return { threads: next, result: next };
  });

  for (const convId of affectedConvIds) {
    const aud = resolveThreadAudience(updatedThreads, convId, "u1");
    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: convId,
      reason: "turn_cancelled",
      timestamp: new Date().toISOString(),
      ...aud,
    });
  }
}

export async function pollPairedAgentTurn(
  ctx: PluginContext,
  viewerUserId?: string,
): Promise<PolledPairedAgentTurn | null> {
  if (!ctx.kv) return null;
  const threads = viewerUserId ? await loadThreads(ctx) : [];
  const records = normalizePairedAgentTurns(await ctx.kv.get("paired_agent_turns_v1"));
  const active = records.find(
    r =>
      (r.status === "running" || r.status === "steered") &&
      (!viewerUserId || isPairedRecordVisibleToViewer(r, threads, viewerUserId)),
  );
  if (active) {
    return projectPolledTurn(active);
  }
  const legacyRaw = await ctx.kv.get("active_turn");
  if (legacyRaw && typeof legacyRaw === "object") {
    const legacy = legacyRaw as Partial<PolledPairedAgentTurn>;
    if (typeof legacy.turnId === "string" && typeof legacy.prompt === "string") {
      return {
        turnId: legacy.turnId,
        prompt: legacy.prompt,
        status:
          legacy.status === "steered" ||
          legacy.status === "completed" ||
          legacy.status === "stopped"
            ? legacy.status
            : "running",
        lastUpdate: typeof legacy.lastUpdate === "string" ? legacy.lastUpdate : "",
        ...(Array.isArray(legacy.steers) ? { steers: legacy.steers } : {}),
        ...(typeof legacy.conversationId === "string"
          ? { conversationId: legacy.conversationId }
          : {}),
        ...(typeof legacy.sessionKey === "string" ? { sessionKey: legacy.sessionKey } : {}),
        ...(typeof legacy.systemContext === "string"
          ? { systemContext: legacy.systemContext }
          : {}),
      };
    }
  }
  return null;
}

const MAX_PAIRED_AGENT_REPLY_CHARS = 32_000;

export async function completePairedAgentTurn(
  ctx: PluginContext,
  connection: OpenClawConnection,
  params: { turnId?: unknown; reply?: unknown; requireReply?: boolean },
): Promise<Record<string, unknown>> {
  let requestedTurnId: string | undefined;
  if (params.turnId !== undefined && params.turnId !== null) {
    requestedTurnId = cleanInputText(params.turnId, 120);
    if (!requestedTurnId) {
      return {
        ok: false,
        error: "INVALID_TURN_ID",
        message: "turnId must be a non-empty string up to 120 characters.",
      };
    }
  }

  let reply: string;
  if (params.reply === undefined) {
    if (params.requireReply) {
      return {
        ok: false,
        error: "INVALID_REPLY",
        message: "reply is required and must be a non-empty string.",
      };
    }
    reply = "Completed.";
  } else if (typeof params.reply !== "string") {
    return {
      ok: false,
      error: "INVALID_REPLY",
      message: "reply must be a string.",
    };
  } else {
    const normalized = params.reply.replace(/\r\n?/g, "\n").trim();
    if (normalized.length === 0) {
      return {
        ok: false,
        error: "INVALID_REPLY",
        message: "reply must not be empty.",
      };
    }
    if (normalized.length > MAX_PAIRED_AGENT_REPLY_CHARS) {
      return {
        ok: false,
        error: "REPLY_TOO_LARGE",
        message: `reply exceeds the ${MAX_PAIRED_AGENT_REPLY_CHARS}-character limit (${normalized.length} characters). Shorten or split the response before calling complete_turn again.`,
      };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(normalized)) {
      return {
        ok: false,
        error: "INVALID_REPLY",
        message: "reply must not contain ASCII control characters.",
      };
    }
    reply = normalized;
  }

  if (!ctx.kv) {
    return {
      ok: false,
      error: "STORAGE_UNAVAILABLE",
      message: "Plugin KV storage is unavailable.",
    };
  }

  const claimResult = await withOpenClawStorageLock("paired_turns", async () => {
    const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
    const idx = requestedTurnId
      ? existing.findIndex(r => r.turnId === requestedTurnId)
      : existing.findIndex(r => r.status === "running" || r.status === "steered");

    if (idx !== -1) {
      const target = existing[idx]!;
      if (target.status === "stopped") {
        return { kind: "error" as const, code: "TURN_ALREADY_STOPPED", message: "The turn was stopped in EmDash before completion." };
      }
      if (target.status === "completed") {
        return { kind: "error" as const, code: "TURN_ALREADY_COMPLETED", message: "The turn has already been completed." };
      }
      const completedRecord: PairedAgentTurnRecord = {
        ...target,
        status: "completed",
        gatheredSnapshot: undefined,
        lastUpdate: reply.slice(0, 500),
      };
      const updated = prunePairedAgentTurns(
        existing.map((r, i) => (i === idx ? completedRecord : r)),
      );
      await ctx.kv!.set("paired_agent_turns_v1", updated);
      return { kind: "native" as const, matched: target };
    }

    const legacyRaw = await ctx.kv!.get("active_turn");
    const legacy =
      legacyRaw && typeof legacyRaw === "object"
        ? (legacyRaw as Partial<PolledPairedAgentTurn>)
        : null;
    if (
      legacy &&
      typeof legacy.turnId === "string" &&
      (!requestedTurnId || legacy.turnId === requestedTurnId)
    ) {
      if (legacy.status === "stopped") {
        return { kind: "error" as const, code: "TURN_ALREADY_STOPPED", message: "The active turn was stopped." };
      }
      if (legacy.status === "completed") {
        return { kind: "error" as const, code: "TURN_ALREADY_COMPLETED", message: "The active turn was already completed." };
      }
      await ctx.kv!.set("active_turn", {
        turnId: legacy.turnId,
        prompt: legacy.prompt ?? "",
        status: "completed",
        lastUpdate: reply.slice(0, 500),
      });
      return { kind: "legacy" as const, turnId: legacy.turnId };
    }

    if (!requestedTurnId && existing.length > 0 && existing[existing.length - 1]?.status === "stopped") {
      return { kind: "error" as const, code: "TURN_ALREADY_STOPPED", message: "The active turn was stopped in EmDash before completion." };
    }

    return {
      kind: "error" as const,
      code: requestedTurnId ? "TURN_NOT_FOUND" : "NO_ACTIVE_TURN",
      message: requestedTurnId
        ? `Turn "${requestedTurnId}" was not found.`
        : "No active turn is waiting for completion.",
    };
  });

  if (claimResult.kind === "error") {
    return {
      ok: false,
      error: claimResult.code,
      message: claimResult.message,
    };
  }

  if (claimResult.kind === "legacy") {
    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: "conv_catalog_overview",
      reason: "external_agent_turn_completed",
      timestamp: new Date().toISOString(),
      visibility: "shared",
    });
    return { ok: true, status: "completed", turnId: claimResult.turnId, reply };
  }

  const matched = claimResult.matched;
  const collections = await listSiteCollections(ctx);
  const enabledSlugs = collections
    .filter(c => connection.enabledCollections.includes(c.slug))
    .map(c => c.slug);

  let cleanedReply = reply;
  const createdProposals: RevisionProposal[] = [];

  if (connection.authorityMode === "propose_with_approval" && /```emdash-proposal\s/i.test(reply)) {
    const candidateEntries: CatalogEntrySummary[] = [...(matched.gatheredSnapshot ?? [])].filter(
      e => enabledSlugs.includes(e.collection),
    );
    const fenceProbe = /```emdash-proposal\s*([\s\S]*?)```/gi;
    let probeMatch: RegExpExecArray | null;
    while ((probeMatch = fenceProbe.exec(reply)) !== null) {
      try {
        const parsed = JSON.parse((probeMatch[1] ?? "").trim()) as {
          collection?: string;
          entryId?: string;
        };
        if (
          parsed &&
          typeof parsed.collection === "string" &&
          enabledSlugs.includes(parsed.collection) &&
          typeof parsed.entryId === "string" &&
          !candidateEntries.some(
            e => e.collection === parsed.collection && e.id === parsed.entryId,
          )
        ) {
          const { item } = await getSingleContentItem(ctx, parsed.collection, parsed.entryId);
          if (item) candidateEntries.push(item);
        }
      } catch {
        // Malformed fence ignored here; parseGatewayAgentProposals strips it cleanly.
      }
    }

    const parsedProposals = parseGatewayAgentProposals(
      reply,
      candidateEntries,
      matched.conversationId,
      connection.agentId,
      matched.turnId,
    );
    cleanedReply = parsedProposals.cleanedText;
    for (const p of parsedProposals.proposals) {
      const targetEntry = candidateEntries.find(
        e => e.collection === p.collection && e.id === p.entryId,
      );
      if (canCollectionStageDraft(collections, p.collection, targetEntry?.status ?? "published")) {
        createdProposals.push(p);
      }
    }
    for (let i = 0; i < createdProposals.length; i++) {
      const check = await doesStoredEntryMatchProposalBase(ctx, createdProposals[i]!);
      if (check.checked && !check.matches) {
        createdProposals[i] = {
          ...createdProposals[i]!,
          status: "conflict",
          conflictRev: check.item?._rev,
          errorMessage:
            "Entry changed while the paired agent turn was running. Rebase or regenerate before saving.",
          updatedAt: new Date().toISOString(),
        };
      }
    }
  }

  if (createdProposals.length > 0) {
    await loadRevisionProposals(ctx);
    await withOpenClawStorageLock("proposals", async () => {
      const fresh = ctx.kv
        ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
        : [];
      await saveRevisionProposals(ctx, [...createdProposals, ...fresh]);
    });
  }

  const proposalIds = createdProposals.map(p => p.proposalId);
  const threadOutcome = await mutateThreads(ctx, [matched.conversationId], current => {
    const targetThread = current.find(t => t.conversationId === matched.conversationId);
    const placeholder = targetThread?.messages.find(
      m => m.messageId === matched.assistantMessageId,
    );
    if (!targetThread || !placeholder || placeholder.status === "stopped") {
      return {
        threads: current,
        result: {
          applied: false,
          code: placeholder?.status === "stopped" ? "TURN_ALREADY_STOPPED" : "TURN_NOT_FOUND",
          threads: current,
        },
      };
    }

    const completedMsg: ChatTurnMessage = {
      ...placeholder,
      runId: matched.turnId,
      content: cleanedReply,
      status: "completed",
      ...(proposalIds.length > 0 ? { proposalIds } : {}),
    };
    const nextMessages = targetThread.messages.map(m =>
      m.messageId === matched.assistantMessageId ? completedMsg : m,
    );
    const nextStreaming = nextMessages.find(m => m.status === "streaming");
    const stillStreaming = Boolean(nextStreaming);
    const updatedThreadBase: ConversationThread = {
      ...targetThread,
      sessionKey: matched.sessionKey,
      lastTurnSessionKey: matched.sessionKey,
      status: stillStreaming ? "running" : "idle",
      activeRunId: stillStreaming ? nextStreaming?.runId : undefined,
      runPhase: stillStreaming ? "awaiting_paired_agent" : undefined,
      updatedAt: new Date().toISOString(),
      messages: nextMessages,
    };
    const updatedThread = stillStreaming
      ? updatedThreadBase
      : bindThreadToAgentSession(updatedThreadBase, connection.agentId);
    const next = current.map(t =>
      t.conversationId === matched.conversationId ? updatedThread : t,
    );
    return {
      threads: next,
      result: {
        applied: true,
        code: "OK",
        threads: next,
      },
    };
  });

  if (!threadOutcome.applied) {
    if (createdProposals.length > 0) {
      const rollbackIds = new Set(proposalIds);
      await withOpenClawStorageLock("proposals", async () => {
        const fresh = ctx.kv
          ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
          : [];
        await saveRevisionProposals(
          ctx,
          fresh.filter(p => !rollbackIds.has(p.proposalId)),
        );
      });
    }
    await withOpenClawStorageLock("paired_turns", async () => {
      const existing = normalizePairedAgentTurns(await ctx.kv!.get("paired_agent_turns_v1"));
      const updated = existing.map(r =>
        r.turnId === matched.turnId ? { ...r, status: "stopped" as const } : r,
      );
      await ctx.kv!.set("paired_agent_turns_v1", updated);
    });
    return {
      ok: false,
      error: threadOutcome.code,
      message: "The originating conversation turn is no longer active.",
    };
  }

  const finalAudience = resolveThreadAudience(
    threadOutcome.threads,
    matched.conversationId,
    matched.ownerUserId ?? "u1",
  );
  const nowIso = new Date().toISOString();

  publishOpenClawEvent({
    type: "assistant_delta",
    conversationId: matched.conversationId,
    messageId: matched.assistantMessageId,
    delta: cleanedReply,
    content: cleanedReply,
    timestamp: nowIso,
    ...finalAudience,
  });

  for (const proposal of createdProposals) {
    publishOpenClawEvent({
      type: "proposal_updated",
      proposal,
      timestamp: nowIso,
      ...finalAudience,
    });
  }

  publishOpenClawEvent({
    type: "workspace_sync",
    conversationId: matched.conversationId,
    reason: "turn_completed",
    timestamp: nowIso,
    ...finalAudience,
  });

  return {
    ok: true,
    status: "completed",
    turnId: matched.turnId,
    conversationId: matched.conversationId,
    proposalIds,
    reply: cleanedReply,
  };
}

export async function openclawChatRoute(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<Record<string, unknown>> {
  const role = route.user?.role ?? 0;
  const currentUserId = route.user?.id || "anonymous";
  if (role < EDITOR) {
    return {
      ok: false,
      error: "FORBIDDEN",
      message: "Only Editors and Administrators can access OpenClaw.",
    };
  }

  const input =
    typeof route.input === "object" && route.input !== null
      ? (route.input as Record<string, unknown>)
      : {};
  const action = cleanInputText(input.action, 60) ?? "get_workspace";
  const boundEntryRaw =
    typeof input.boundEntry === "object" && input.boundEntry !== null
      ? (input.boundEntry as Record<string, unknown>)
      : undefined;
  const boundEntry: BoundEntryRef | undefined =
    boundEntryRaw &&
    typeof boundEntryRaw.collection === "string" &&
    typeof boundEntryRaw.entryId === "string"
      ? {
          collection: boundEntryRaw.collection,
          entryId: boundEntryRaw.entryId,
          locale: cleanInputText(boundEntryRaw.locale, 24),
          title: cleanInputText(boundEntryRaw.title, 180),
          slug: cleanInputText(boundEntryRaw.slug, 180),
        }
      : undefined;

  const preferredConversationId = cleanInputText(input.conversationId, 120);
  const extraEnv = extractRouteRuntimeEnv(route) ?? extractRouteRuntimeEnv(ctx);
  const visitorHash = await resolvePlaygroundVisitorHash(route);
  const playgroundLocked = isPlaygroundLocked(extraEnv);

  if (action === "get_workspace") {
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (
    playgroundLocked &&
    (action === "configure_connection" ||
      action === "save_settings" ||
      action === "save_connection" ||
      action === "disconnect" ||
      action === "rotate_pairing_code" ||
      action === "resolve_gateway_approval")
  ) {
    return {
      ok: false,
      error: "PLAYGROUND_LOCKED",
      playgroundLocked: true,
      message: PLAYGROUND_LOCKED_MESSAGE,
    };
  }

  if (action === "rotate_pairing_code" && role >= ADMIN) {
    await rotateSitePairingCode(ctx);
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if ((action === "configure_connection" || action === "save_settings") && role >= ADMIN) {
    const existingState = await readConnectionSettingsState(ctx, extraEnv);
    const existing = existingState.connection;
    const collections = await listSiteCollections(ctx);
    const bridge = getHostGatewayBridge();

    const explicitGatewayUrl = cleanInputText(input.gatewayUrl, 400);
    const rawToken = cleanInputText(input.gatewayToken, 400);

    let gatewayUrl: string;
    let extractedToken = rawToken;
    let extractedBootstrapToken: string | undefined;

    if (explicitGatewayUrl) {
      if (explicitGatewayUrl === "https://agent-session.openclaw.local") {
        gatewayUrl = explicitGatewayUrl;
      } else if (bridge) {
        const normalized = bridge.normalizeGatewayInput(explicitGatewayUrl, rawToken);
        if (!normalized.ok) {
          return {
            ok: false,
            error: "INVALID_GATEWAY_URL",
            message: normalized.error ?? "Invalid OpenClaw Gateway URL.",
          };
        }
        gatewayUrl = normalized.wsUrl ?? normalized.httpUrl ?? sanitizePublicGatewayUrl(explicitGatewayUrl);
        if (normalized.extractedToken) {
          extractedToken = normalized.extractedToken;
        }
        if (!rawToken && normalized.extractedBootstrapToken) {
          extractedBootstrapToken = normalized.extractedBootstrapToken;
        }
      } else {
        const checked = validateDirectGatewayUrlInput(explicitGatewayUrl);
        if (!checked.ok || !checked.sanitizedUrl) {
          return {
            ok: false,
            error: "INVALID_GATEWAY_URL",
            message: checked.error ?? "Invalid OpenClaw Gateway URL.",
          };
        }
        gatewayUrl = checked.sanitizedUrl;
        if (!extractedToken && checked.extractedToken) {
          extractedToken = checked.extractedToken;
        }
        if (!extractedToken && checked.extractedBootstrapToken) {
          extractedBootstrapToken = checked.extractedBootstrapToken;
        }
      }
    } else if (existing?.gatewayUrl) {
      gatewayUrl = sanitizePublicGatewayUrl(existing.gatewayUrl);
    } else {
      gatewayUrl = "https://agent-session.openclaw.local";
    }

    if (existingState.error && !extractedToken && !extractedBootstrapToken) {
      return {
        ok: false,
        error: "SETTINGS_READ_ERROR",
        message: `${existingState.error} Provide a Gateway token explicitly to replace stored credentials.`,
      };
    }

    const explicitAgentId = cleanInputText(input.agentId, 80);
    if (explicitAgentId !== undefined && !/[a-z0-9]/i.test(explicitAgentId)) {
      return {
        ok: false,
        error: "INVALID_AGENT_ID",
        message: "OpenClaw agentId must contain at least one alphanumeric character.",
      };
    }
    const agentId = explicitAgentId ?? existing?.agentId ?? "openclaw";
    const sameGatewayEndpoint = Boolean(
      existing && sanitizePublicGatewayUrl(existing.gatewayUrl) === sanitizePublicGatewayUrl(gatewayUrl),
    );
    const gatewayToken = extractedBootstrapToken
      ? (extractedToken ?? csprngId("oc_sess_", 20))
      : extractedToken
        ? extractedToken
        : sameGatewayEndpoint && existing?.gatewayToken
          ? existing.gatewayToken
          : csprngId("oc_sess_", 20);
    const bootstrapToken = extractedBootstrapToken
      ? extractedBootstrapToken
      : extractedToken
        ? undefined
        : sameGatewayEndpoint
          ? existing?.bootstrapToken
          : undefined;
    const retainedDeviceToken =
      extractedBootstrapToken || !sameGatewayEndpoint ? undefined : existing?.deviceToken;
    const authorityMode =
      input.authorityMode === "propose_with_approval"
        ? "propose_with_approval"
        : input.authorityMode === "read_only"
          ? "read_only"
          : (existing?.authorityMode ?? "propose_with_approval");
    const allowGatewayExecApprovals =
      typeof input.allowGatewayExecApprovals === "boolean"
        ? input.allowGatewayExecApprovals
        : Boolean(existing?.allowGatewayExecApprovals);
    const enabledCollections = Array.isArray(input.enabledCollections)
      ? input.enabledCollections.filter((c): c is string => typeof c === "string")
      : (existing?.enabledCollections ?? collections.map(c => c.slug));

    const deviceIdentity = bridge
      ? bridge.ensureDeviceIdentity(existing?.deviceIdentity)
      : existing?.deviceIdentity;

    const pairedAgentPoll =
      gatewayUrl === "https://agent-session.openclaw.local"
        ? typeof input.pairedAgentPoll === "boolean"
          ? input.pairedAgentPoll
          : Boolean(existing?.pairedAgentPoll)
        : false;

    const updated: OpenClawConnection = {
      gatewayUrl,
      agentId,
      gatewayToken,
      ...(bootstrapToken ? { bootstrapToken } : {}),
      ...(retainedDeviceToken ? { deviceToken: retainedDeviceToken } : {}),
      ...(deviceIdentity ? { deviceIdentity } : {}),
      authorityMode,
      allowGatewayExecApprovals,
      ...(pairedAgentPoll ? { pairedAgentPoll: true } : {}),
      enabledCollections,
    };
    await persistConnectionSettings(ctx, updated);
    if (existing?.pairedAgentPoll && !pairedAgentPoll) {
      await cancelAllPairedAgentTurns(
        ctx,
        "Gateway connection updated; pending paired-agent turn was cancelled.",
      );
    }

    await mutateThreads(ctx, [], current => {
      let changed = false;
      const next = current.map(t => {
        if (t.status === "running") return t;
        const expectedKey = resolveThreadSessionKey(t, updated.agentId, visitorHash);
        if (t.sessionKey === expectedKey) return t;
        changed = true;
        const rebound = bindThreadToAgentSession(t, updated.agentId, expectedKey, visitorHash);
        bridge?.updateSessionAudience(expectedKey, {
          ownerUserId: t.ownerUserId ?? currentUserId,
          visibility: t.visibility ?? "personal",
        });
        return rebound;
      });
      return { threads: changed ? next : current, result: undefined };
    });

    if (bridge && classifyTransportMode(gatewayUrl) === "gateway-ws") {
      await bridge.connect(updated, patch =>
        persistIssuedDeviceCredentials(ctx, updated.gatewayUrl, patch),
      );
    } else if (bridge) {
      await bridge.disconnect();
    }

    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: preferredConversationId ?? "conv_catalog_overview",
      reason: "connection_updated",
      timestamp: new Date().toISOString(),
      visibility: "shared",
    });
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "probe_gateway" && role >= ADMIN) {
    const connState = await readConnectionSettingsState(ctx, extraEnv);
    const connection = connState.connection;
    const bridge = getHostGatewayBridge();
    if (connection && bridge && classifyTransportMode(connection.gatewayUrl) === "gateway-ws") {
      await bridge.connect(connection, patch =>
        persistIssuedDeviceCredentials(ctx, connection.gatewayUrl, patch),
      );
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "disconnect" && role >= ADMIN) {
    const bridge = getHostGatewayBridge();
    if (bridge) await bridge.disconnect();
    await cancelAllPairedAgentTurns(
      ctx,
      "OpenClaw connection disconnected before paired agent completed the turn.",
    );
    await ctx.settings.delete("connection");
    await rotateSitePairingCode(ctx);
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "toggle_automation" && role >= ADMIN) {
    const automationId = cleanInputText(input.automationId, 80);
    const collections = await listSiteCollections(ctx);
    await withOpenClawStorageLock("automations", async () => {
      const automations = await loadAutomations(ctx, collections);
      const next = automations.map(rule =>
        rule.automationId === automationId ? { ...rule, enabled: !rule.enabled } : rule,
      );
      if (ctx.kv) {
        await ctx.kv.set("openclaw_automations_v1", next);
      }
    });
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "create_thread") {
    const connection = await readConnectionSettings(ctx, extraEnv);
    const collections = await listSiteCollections(ctx);
    const title = cleanInputText(input.title, 120) ?? "New Store Conversation";
    const visibility = input.visibility === "shared" ? "shared" : "personal";
    const scopeGroup =
      cleanInputText(input.scopeGroup, 60) ??
      (collections.some(c => c.slug === "products") ? "products" : "pages & storefront");
    const now = new Date().toISOString();
    const convId = csprngId("conv_", 8);
    const initialAgent = connection?.agentId ?? "openclaw";
    const initialSessionKey = buildCanonicalSessionKey(initialAgent, convId, visitorHash);
    const newThread: ConversationThread = {
      conversationId: convId,
      ownerUserId: currentUserId,
      visibility,
      sessionKey: initialSessionKey,
      agentSessionKeys: { [normalizeOpenClawAgentSegment(initialAgent)]: initialSessionKey },
      title,
      scopeGroup,
      boundEntry,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await mutateThreads(ctx, [convId], current => ({
      threads: [newThread, ...current],
      result: undefined,
    }));
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      newThread.conversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "toggle_thread_visibility") {
    const targetId = preferredConversationId;
    if (targetId) {
      const connection = await readConnectionSettings(ctx, extraEnv);
      const bridge = getHostGatewayBridge();
      const forbidden = await mutateThreads(ctx, [targetId], current => {
        const existing = current.find(t => t.conversationId === targetId);
        if (!existing || !isThreadVisibleToUser(existing, currentUserId)) {
          return { threads: current, result: true };
        }
        if (existing.ownerUserId && existing.ownerUserId !== currentUserId && role < ADMIN) {
          return { threads: current, result: true };
        }
        const next = current.map(t => {
          if (t.conversationId !== targetId) return t;
          const nextVis: "personal" | "shared" =
            t.visibility === "shared" ? "personal" : "shared";
          const audience = {
            ownerUserId: t.ownerUserId ?? currentUserId,
            visibility: nextVis,
          };
          if (t.status === "running" && t.sessionKey) {
            bridge?.updateSessionAudience(t.sessionKey, audience);
            return { ...t, visibility: nextVis, updatedAt: new Date().toISOString() };
          }
          const rebound = bindThreadToAgentSession(
            t,
            connection?.agentId ?? "openclaw",
            undefined,
            visitorHash,
          );
          if (t.sessionKey && t.sessionKey !== rebound.sessionKey) {
            bridge?.updateSessionAudience(t.sessionKey, audience);
          }
          bridge?.updateSessionAudience(rebound.sessionKey!, audience);
          return { ...rebound, visibility: nextVis, updatedAt: new Date().toISOString() };
        });
        return { threads: next, result: false };
      });
      if (forbidden) {
        return {
          ok: false,
          error: "FORBIDDEN",
          message: "Only the conversation owner or an Administrator can change thread visibility.",
        };
      }
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "stamp_proposal_rev" || action === "rebase_proposal") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const baseRev = cleanInputText(input.baseRev, 240);
    if (proposalId && baseRev) {
      await loadRevisionProposals(ctx);
      const threads = await loadThreads(ctx);
      const outcome = await withOpenClawStorageLock("proposals", async () => {
        const proposals = ctx.kv
          ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
          : [];
        const target = proposals.find(p => p.proposalId === proposalId);
        if (!target) return { error: null as Record<string, unknown> | null };
        const owningThread = threads.find(t => t.conversationId === target.conversationId);
        if (owningThread && !isThreadVisibleToUser(owningThread, currentUserId)) {
          return {
            error: {
              ok: false,
              error: "FORBIDDEN",
              message: "Conversation access denied.",
            },
          };
        }
        const now = new Date().toISOString();
        let updatedProposal: RevisionProposal | undefined;

        if (action === "rebase_proposal") {
          if (
            target.status !== "pending" &&
            target.status !== "conflict" &&
            target.status !== "failed"
          ) {
            return {
              error: {
                ok: false,
                error: "PROPOSAL_NOT_PENDING",
                message: `Proposal cannot be rebased because its status is "${target.status}".`,
              },
            };
          }
          const { item } = await getSingleContentItem(
            ctx,
            target.collection,
            target.entryId,
            target.locale,
          );
          const refreshedDiffs: ContentFieldDiff[] = item
            ? target.diffs.map(d => {
                const rawVal = item.fields[d.field];
                const beforeVal =
                  typeof rawVal === "string"
                    ? rawVal
                    : d.field === "title" || d.field === "name"
                      ? item.title
                      : "";
                return {
                  ...d,
                  before: beforeVal || "(empty)",
                  ...countDiffLines(beforeVal, d.after),
                };
              })
            : target.diffs;
          const next = proposals.map(p => {
            if (p.proposalId !== proposalId) return p;
            updatedProposal = {
              ...p,
              baseRev,
              diffs: refreshedDiffs,
              status: "pending",
              conflictRev: undefined,
              errorMessage: undefined,
              updatedAt: now,
            };
            return updatedProposal;
          });
          await saveRevisionProposals(ctx, next);
        } else if (
          target.status === "pending" &&
          (target.baseRev === "pending-browser-rev" || target.baseRev.startsWith("v"))
        ) {
          const baseCheck = await doesStoredEntryMatchProposalBase(ctx, target);
          const next = proposals.map(p => {
            if (p.proposalId !== proposalId) return p;
            if (baseCheck.checked && !baseCheck.matches) {
              updatedProposal = {
                ...p,
                status: "conflict",
                conflictRev: baseRev,
                errorMessage:
                  "Entry changed before revision token was bound. Rebase or regenerate before saving.",
                updatedAt: now,
              };
              return updatedProposal;
            }
            updatedProposal = { ...p, baseRev, updatedAt: now };
            return updatedProposal;
          });
          await saveRevisionProposals(ctx, next);
        }

        if (updatedProposal) {
          publishOpenClawEvent({
            type: "proposal_updated",
            proposal: updatedProposal,
            timestamp: now,
            ...resolveThreadAudience(threads, target.conversationId, currentUserId),
          });
        }
        return { error: null };
      });
      if (outcome.error) return outcome.error;
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  /**
   * Immutable "Edit & Approve" revisioning (Section 4):
   * Never silently alters the payload under an existing proposalId; marks the
   * prior proposal `superseded` and mints `revisionNumber + 1` linked via
   * `supersedesProposalId`.
   */
  if (action === "revise_proposal") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const editedFields =
      typeof input.proposedFields === "object" && input.proposedFields !== null
        ? (input.proposedFields as Record<string, unknown>)
        : undefined;
    if (proposalId && editedFields) {
      await loadRevisionProposals(ctx);
      const threads = await loadThreads(ctx);
      const collections = await listSiteCollections(ctx);
      const connState = await readConnectionSettingsState(ctx, extraEnv);
      const outcome = await withOpenClawStorageLock("proposals", async () => {
        const proposals = ctx.kv
          ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
          : [];
        const parent = proposals.find(p => p.proposalId === proposalId);
        if (!parent) {
          return {
            error: {
              ok: false,
              error: "PROPOSAL_NOT_FOUND",
              message: "Proposal no longer exists.",
            } as Record<string, unknown>,
          };
        }
        const owningThread = threads.find(t => t.conversationId === parent.conversationId);
        if (owningThread && !isThreadVisibleToUser(owningThread, currentUserId)) {
          return {
            error: {
              ok: false,
              error: "FORBIDDEN",
              message: "Conversation access denied.",
            } as Record<string, unknown>,
          };
        }
        const scopeErr = checkProposalConnectionScope(connState, parent.collection);
        if (scopeErr) {
          return { error: scopeErr };
        }
        if (parent.status !== "pending" && parent.status !== "failed") {
          return {
            error: {
              ok: false,
              error: "PROPOSAL_NOT_PENDING",
              message: `Proposal cannot be revised because its status is "${parent.status}".`,
            } as Record<string, unknown>,
          };
        }
        const sanitizedPatch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(editedFields)) {
          if (!EXCLUDED_DRAFT_ONLY_FIELDS.has(k) && typeof v === "string") {
            sanitizedPatch[k] = v;
          }
        }
        if (Object.keys(sanitizedPatch).length === 0 || parent.entryId === "current") {
          return {
            error: {
              ok: false,
              error: "NO_CONCRETE_PATCH",
              message:
                "Provide at least one draft-safe field edit on a concrete EmDash entry before revising.",
            } as Record<string, unknown>,
          };
        }
        const { item: storedEntry } = await getSingleContentItem(
          ctx,
          parent.collection,
          parent.entryId,
          parent.locale,
        );
        if (!canCollectionStageDraft(collections, parent.collection, storedEntry?.status ?? "published")) {
          return {
            error: {
              ok: false,
              error: "REVISIONS_NOT_SUPPORTED",
              message: `Collection "${parent.collection}" does not support staging drafts for ${storedEntry?.status ?? "published"} entries — saving would modify live content immediately.`,
            } as Record<string, unknown>,
          };
        }
        const now = new Date().toISOString();
        const nextProposalId = csprngId("prop_", 8);
        const mergedFields = { ...parent.proposedFields, ...sanitizedPatch };
        const existingDiffFields = new Set(parent.diffs.map(d => d.field));
        const updatedExistingDiffs = parent.diffs
          .filter(d => d.field in mergedFields)
          .map(d =>
            d.field in sanitizedPatch
              ? {
                  ...d,
                  after: sanitizedPatch[d.field] as string,
                  ...countDiffLines(
                    d.before === "(empty)" ? "" : d.before,
                    sanitizedPatch[d.field] as string,
                  ),
                }
              : d,
          );
        const addedDiffs: ContentFieldDiff[] = Object.entries(sanitizedPatch)
          .filter(([field]) => !existingDiffFields.has(field))
          .map(([field, val]) => {
            const rawBefore = storedEntry?.fields[field];
            const beforeVal =
              typeof rawBefore === "string"
                ? rawBefore
                : field === "title" || field === "name"
                  ? (storedEntry?.title ?? "")
                  : "";
            return {
              field,
              label: field,
              before: beforeVal || "(empty)",
              after: String(val),
              ...countDiffLines(beforeVal, String(val)),
            };
          });
        const nextDiffs = [...updatedExistingDiffs, ...addedDiffs];
        const revised: RevisionProposal = {
          ...parent,
          proposalId: nextProposalId,
          revisionNumber: (parent.revisionNumber ?? 1) + 1,
          supersedesProposalId: parent.proposalId,
          baseRev:
            parent.baseRev === "pending-browser-rev" && storedEntry?._rev
              ? storedEntry._rev
              : parent.baseRev,
          proposedFields: mergedFields,
          diffs: nextDiffs,
          status: "pending",
          errorMessage: undefined,
          decidedByUserId: currentUserId,
          createdAt: now,
          updatedAt: now,
        };
        const nextList: RevisionProposal[] = [
          revised,
          ...proposals.map(p =>
            p.proposalId === parent.proposalId
              ? {
                  ...p,
                  status: "superseded" as const,
                  supersededByProposalId: nextProposalId,
                  updatedAt: now,
                }
              : p,
          ),
        ];
        await saveRevisionProposals(ctx, nextList);
        return {
          error: null,
          revised,
          parentId: parent.proposalId,
          conversationId: parent.conversationId,
          now,
        };
      });

      if (outcome.error) {
        return outcome.error;
      }

      if (outcome.revised) {
        const updatedThreads = await mutateThreads(
          ctx,
          [outcome.conversationId],
          current => {
            const next = current.map(t => {
              if (t.conversationId !== outcome.conversationId) return t;
              return {
                ...t,
                messages: t.messages.map(m =>
                  m.proposalIds?.includes(outcome.parentId)
                    ? {
                        ...m,
                        proposalIds: m.proposalIds.map(id =>
                          id === outcome.parentId ? outcome.revised.proposalId : id,
                        ),
                      }
                    : m,
                ),
              };
            });
            return { threads: next, result: next };
          },
        );

        publishOpenClawEvent({
          type: "proposal_updated",
          proposal: outcome.revised,
          timestamp: outcome.now,
          ...resolveThreadAudience(updatedThreads, outcome.conversationId, currentUserId),
        });
        return {
          ...((await buildWorkspaceSnapshot(
            route,
            ctx,
            preferredConversationId,
            boundEntry,
          )) as unknown as Record<string, unknown>),
          revisedProposalId: outcome.revised.proposalId,
        };
      }
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  /**
   * Server-side pre-apply fence (`Pending | Failed -> Applying`):
   * Prevents stale tabs from applying already-rejected/superseded/applied proposals
   * and blocks collections where `PUT` would mutate live published content directly.
   */
  if (action === "begin_apply_proposal") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const expectedRev = cleanInputText(input.expectedRev, 240);
    if (!proposalId) {
      return {
        ok: false,
        error: "INVALID_PROPOSAL",
        message: "Proposal ID is required.",
      };
    }

    await loadRevisionProposals(ctx);
    const threads = await loadThreads(ctx);
    const collections = await listSiteCollections(ctx);
    const connState = await readConnectionSettingsState(ctx, extraEnv);

    const outcome = await withOpenClawStorageLock("proposals", async () => {
      const proposals = ctx.kv
        ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
        : [];
      const target = proposals.find(p => p.proposalId === proposalId);
      if (!target) {
        return {
          error: {
            ok: false,
            error: "PROPOSAL_NOT_FOUND",
            message: "Proposal no longer exists.",
          } as Record<string, unknown>,
          applyReady: false,
        };
      }
      const owningThread = threads.find(t => t.conversationId === target.conversationId);
      if (owningThread && !isThreadVisibleToUser(owningThread, currentUserId)) {
        return {
          error: {
            ok: false,
            error: "FORBIDDEN",
            message: "Conversation access denied.",
          } as Record<string, unknown>,
          applyReady: false,
        };
      }
      if (Object.keys(target.proposedFields ?? {}).length === 0 || target.entryId === "current") {
        return {
          error: {
            ok: false,
            error: "NO_CONCRETE_PATCH",
            message: "Summary-only proposal has no concrete field patch and cannot be applied.",
          } as Record<string, unknown>,
          applyReady: false,
        };
      }
      if (target.status !== "pending" && target.status !== "failed") {
        return {
          error: {
            ok: false,
            error: "PROPOSAL_NOT_PENDING",
            message: `Proposal cannot be applied because its status is "${target.status}".`,
          } as Record<string, unknown>,
          applyReady: false,
        };
      }
      const scopeErr = checkProposalConnectionScope(connState, target.collection);
      if (scopeErr) {
        return {
          error: scopeErr,
          applyReady: false,
        };
      }

      const baseCheck = await doesStoredEntryMatchProposalBase(ctx, target);
      const entryStatus = baseCheck.item?.status ?? "published";
      if (!canCollectionStageDraft(collections, target.collection, entryStatus)) {
        return {
          error: {
            ok: false,
            error: "REVISIONS_NOT_SUPPORTED",
            message: `Collection "${target.collection}" does not support staging drafts for ${entryStatus} entries — saving would modify live content immediately.`,
          } as Record<string, unknown>,
          applyReady: false,
        };
      }

      const hasOpaqueTargetRev =
        Boolean(target.baseRev) &&
        !target.baseRev.startsWith("v") &&
        target.baseRev !== "pending-browser-rev";
      const revMismatch =
        Boolean(expectedRev) && hasOpaqueTargetRev && target.baseRev !== expectedRev;

      const now = new Date().toISOString();
      if ((baseCheck.checked && !baseCheck.matches) || revMismatch) {
        let conflicted: RevisionProposal | undefined;
        const next = proposals.map(p => {
          if (p.proposalId !== proposalId) return p;
          conflicted = {
            ...p,
            status: "conflict",
            conflictRev: expectedRev ?? baseCheck.item?._rev,
            errorMessage: "Entry was modified by another save since this proposal was created.",
            updatedAt: now,
          };
          return conflicted;
        });
        await saveRevisionProposals(ctx, next);
        if (conflicted) {
          publishOpenClawEvent({
            type: "proposal_updated",
            proposal: conflicted,
            timestamp: now,
            ...resolveThreadAudience(threads, target.conversationId, currentUserId),
          });
        }
        return { error: null, applyReady: false };
      }

      let applying: RevisionProposal | undefined;
      const next = proposals.map(p => {
        if (p.proposalId !== proposalId) return p;
        applying = {
          ...p,
          status: "applying",
          decidedByUserId: currentUserId,
          ...(expectedRev ? { baseRev: expectedRev } : {}),
          errorMessage: undefined,
          updatedAt: now,
        };
        return applying;
      });
      await saveRevisionProposals(ctx, next);
      if (applying) {
        publishOpenClawEvent({
          type: "proposal_updated",
          proposal: applying,
          timestamp: now,
          ...resolveThreadAudience(threads, target.conversationId, currentUserId),
        });
      }
      return { error: null, applyReady: true };
    });

    if (outcome.error) {
      return outcome.error;
    }

    return {
      ...((await buildWorkspaceSnapshot(
        route,
        ctx,
        preferredConversationId,
        boundEntry,
      )) as unknown as Record<string, unknown>),
      applyReady: outcome.applyReady,
    };
  }

  if (action === "record_proposal_receipt" || action === "reconcile_proposal") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const statusRaw = cleanInputText(input.status, 40) as ProposalLifecycleStatus | undefined;
    const appliedRev = cleanInputText(input.appliedRev, 240);
    const observedRev = cleanInputText(input.observedRev, 240);
    const conflictRev = cleanInputText(input.conflictRev, 240);
    const baseRev = cleanInputText(input.baseRev, 240);
    const errorMessage = cleanInputText(input.errorMessage, 400);
    const clientVerifiedMatch =
      typeof input.clientVerifiedMatch === "boolean" ? input.clientVerifiedMatch : undefined;

    if (proposalId) {
      await loadRevisionProposals(ctx);
      const threads = await loadThreads(ctx);
      const connState = await readConnectionSettingsState(ctx, extraEnv);
      const outcome = await withOpenClawStorageLock("proposals", async () => {
        const proposals = ctx.kv
          ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
          : [];
        const target = proposals.find(p => p.proposalId === proposalId);
        if (!target) return { error: null as Record<string, unknown> | null };
        const owningThread = threads.find(t => t.conversationId === target.conversationId);
        if (owningThread && !isThreadVisibleToUser(owningThread, currentUserId)) {
          return {
            error: {
              ok: false,
              error: "FORBIDDEN",
              message: "Conversation access denied.",
            },
          };
        }

        const isFinalizedProposal =
          target.status === "applied" ||
          target.status === "rejected" ||
          target.status === "superseded";

        if (action === "record_proposal_receipt") {
          const validReceiptStatuses = new Set<ProposalLifecycleStatus>([
            "applied",
            "conflict",
            "failed",
            "outcome_unknown",
            "rejected",
          ]);
          if (!statusRaw || !validReceiptStatuses.has(statusRaw)) {
            return {
              error: {
                ok: false,
                error: "INVALID_RECEIPT_STATUS",
                message: "Unsupported proposal receipt status.",
              },
            };
          }
          if (isFinalizedProposal) {
            return {
              error: {
                ok: false,
                error: "PROPOSAL_ALREADY_FINALIZED",
                message: `Proposal cannot transition to "${statusRaw}" because its status is "${target.status}".`,
              },
            };
          }
          if (
            statusRaw === "rejected" &&
            target.status !== "pending" &&
            target.status !== "conflict" &&
            target.status !== "failed"
          ) {
            return {
              error: {
                ok: false,
                error: "PROPOSAL_ALREADY_FINALIZED",
                message: `Proposal cannot be rejected because its status is "${target.status}".`,
              },
            };
          }
          if (
            (statusRaw === "conflict" || statusRaw === "failed") &&
            target.status === "outcome_unknown"
          ) {
            return {
              error: {
                ok: false,
                error: "PROPOSAL_RECONCILIATION_REQUIRED",
                message:
                  'Proposal save outcome is unknown; reconcile with EmDash before recording a conflict or failure.',
              },
            };
          }
        } else {
          if (target.status === "applied") {
            return { error: null };
          }
          if (target.status !== "applying" && target.status !== "outcome_unknown") {
            return {
              error: {
                ok: false,
                error: "PROPOSAL_NOT_PENDING",
                message: `Proposal cannot be reconciled because its status is "${target.status}".`,
              },
            };
          }
        }

        let verifiedStatus: ProposalLifecycleStatus =
          action === "reconcile_proposal" ? target.status : (statusRaw ?? target.status);
        let reconciledServerSide = target.reconciledServerSide;
        let finalError = errorMessage;
        let finalAppliedRev = appliedRev;

        if (
          (verifiedStatus === "applied" || verifiedStatus === "outcome_unknown") &&
          Object.keys(target.proposedFields ?? {}).length === 0
        ) {
          return {
            error: {
              ok: false,
              error: "NO_CONCRETE_PATCH",
              message:
                "Summary-only proposal has no concrete field patch and cannot be marked applied.",
            },
          };
        }
        if (
          action === "record_proposal_receipt" &&
          (verifiedStatus === "applied" || verifiedStatus === "outcome_unknown") &&
          target.status !== "applying"
        ) {
          const scopeErr = checkProposalConnectionScope(connState, target.collection);
          if (scopeErr) {
            return { error: scopeErr };
          }
        }

        // Server-side content reconciliation: never trust a browser `applied` claim if stored CMS fields disagree,
        // and recover `outcome_unknown` / interrupted `applying` saves deterministically!
        if (
          verifiedStatus === "applied" ||
          verifiedStatus === "outcome_unknown" ||
          action === "reconcile_proposal"
        ) {
          const check = await verifyFieldsOnStoredEntry(ctx, target);
          if (check.checked) {
            reconciledServerSide = true;
            if (check.matches) {
              verifiedStatus = "applied";
              finalError = undefined;
            } else if (verifiedStatus === "applied") {
              verifiedStatus = "outcome_unknown";
              finalError =
                "Save acknowledgement could not be verified against stored EmDash content. Click Reconcile to re-check.";
            } else if (action === "reconcile_proposal") {
              verifiedStatus = "pending";
              finalError =
                "Stored EmDash entry still has prior content — the interrupted save did not apply. Safe to retry.";
            }
          } else if (action === "reconcile_proposal" && clientVerifiedMatch !== undefined) {
            reconciledServerSide = false;
            if (clientVerifiedMatch) {
              verifiedStatus = "applied";
              finalAppliedRev = finalAppliedRev ?? observedRev;
              finalError = undefined;
            } else {
              verifiedStatus = "pending";
              finalError =
                "Stored EmDash draft still has prior content — the interrupted save did not apply. Safe to retry.";
            }
          }
        }

        let updatedProposal: RevisionProposal | undefined;
        const next = proposals.map(p => {
          if (p.proposalId !== proposalId) return p;
          updatedProposal = {
            ...p,
            status: verifiedStatus,
            decidedByUserId: currentUserId,
            ...(reconciledServerSide !== undefined ? { reconciledServerSide } : {}),
            ...(baseRev ? { baseRev } : {}),
            ...(finalAppliedRev ? { appliedRev: finalAppliedRev } : {}),
            ...(conflictRev ? { conflictRev } : {}),
            errorMessage: finalError,
            updatedAt: new Date().toISOString(),
          };
          return updatedProposal;
        });
        await saveRevisionProposals(ctx, next);
        if (updatedProposal) {
          publishOpenClawEvent({
            type: "proposal_updated",
            proposal: updatedProposal,
            timestamp: new Date().toISOString(),
            ...resolveThreadAudience(threads, target.conversationId, currentUserId),
          });
        }
        return { error: null };
      });
      if (outcome.error) return outcome.error;
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  /**
   * Dual-Authority Gateway Execution Approval resolution (Section 4):
   * CMS draft permission (`content:edit_any`) NEVER automatically grants Gateway
   * execution approval authority. Requires Site Admin (`role >= ADMIN`),
   * explicit `allowGatewayExecApprovals` opt-in, and `operator.approvals` scope.
   */
  if (action === "resolve_gateway_approval") {
    const approvalId = cleanInputText(input.approvalId, 160);
    const decision = cleanInputText(input.decision, 30) as GatewayApprovalDecision | undefined;
    const kindRaw = cleanInputText(input.kind, 30);
    const kind =
      kindRaw === "plugin"
        ? "plugin"
        : kindRaw === "system-agent"
          ? "system-agent"
          : "exec";

    if (role < ADMIN) {
      return {
        ok: false,
        error: "GATEWAY_APPROVAL_FORBIDDEN",
        message:
          "Permission to approve EmDash CMS drafts does not grant Gateway execution approval authority. Site Administrator role required.",
      };
    }

    const connection = await readConnectionSettings(ctx, extraEnv);
    if (!connection?.allowGatewayExecApprovals) {
      return {
        ok: false,
        error: "GATEWAY_APPROVAL_DISABLED",
        message:
          "Inline Gateway execution approvals are disabled by default. Enable in Gateway & Pairing or resolve in OpenClaw Control UI.",
      };
    }

    const bridge = getHostGatewayBridge();
    if (!bridge || !approvalId || !decision) {
      return {
        ok: false,
        error: "GATEWAY_BRIDGE_UNAVAILABLE",
        message: "Active OpenClaw Gateway WebSocket bridge is required to resolve approvals.",
      };
    }

    const res = await bridge.resolveApproval({
      connection,
      approvalId,
      kind,
      decision,
      resolvedByUserId: currentUserId,
    });

    if (res.approval) {
      await upsertPersistedExecApprovals(ctx, [res.approval]);
    }

    if (!res.ok) {
      return {
        ok: false,
        error: "GATEWAY_APPROVAL_FAILED",
        message: res.error ?? "Gateway rejected approval resolution.",
      };
    }

    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "stop_turn") {
    const connection = await readConnectionSettings(ctx, extraEnv);
    const bridge = getHostGatewayBridge();
    const initialThreads = await loadThreads(ctx);
    const target = initialThreads.find(
      t =>
        isThreadVisibleToUser(t, currentUserId) &&
        (!preferredConversationId || t.conversationId === preferredConversationId),
    );
    if (!target) {
      if (preferredConversationId) {
        return {
          ok: false,
          error: "NOT_FOUND",
          message: "Conversation not found or not accessible.",
        };
      }
      return (await buildWorkspaceSnapshot(
        route,
        ctx,
        preferredConversationId,
        boundEntry,
      )) as unknown as Record<string, unknown>;
    }
    if (connection && classifyTransportMode(connection.gatewayUrl) === "gateway-ws") {
      if (!bridge) {
        return {
          ok: false,
          error: "STOP_FAILED",
          message: "Gateway WebSocket bridge is unavailable.",
        };
      }
      const abortRes = await bridge.abortTurn({
        connection,
        sessionKey:
          target.status === "running" && target.sessionKey
            ? target.sessionKey
            : resolveThreadSessionKey(target, connection.agentId, visitorHash),
        runId: target.activeRunId,
      });
      if (!abortRes.ok) {
        return {
          ok: false,
          error: "STOP_FAILED",
          message: abortRes.error ?? "Gateway could not abort the active run.",
        };
      }
    }

    const targetId = target.conversationId;
    await stopPairedAgentTurns(ctx, targetId, currentUserId);
    await mutateThreads(ctx, [targetId], current => {
      const next = current.map(t => {
        if (t.conversationId !== targetId || !isThreadVisibleToUser(t, currentUserId)) return t;
        return {
          ...t,
          status: "stopped" as const,
          activeRunId: undefined,
          runPhase: undefined,
          updatedAt: new Date().toISOString(),
          messages: t.messages.map(m =>
            m.status === "streaming" || m.status === "queued"
              ? { ...m, status: "stopped" as const }
              : m,
          ),
        };
      });
      return { threads: next, result: undefined };
    });
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "send_message" || action === "steer_turn") {
    const prompt = cleanInputText(input.prompt, 2000);
    if (!prompt) {
      return {
        ok: false,
        error: "EMPTY_PROMPT",
        message: "Enter a message for OpenClaw.",
      };
    }

    const connState = await readConnectionSettingsState(ctx, extraEnv);
    let connection = connState.connection;
    const collections = await listSiteCollections(ctx);
    if (!connection && !connState.error && !playgroundLocked && role >= ADMIN) {
      connection = {
        gatewayUrl: "https://agent-session.openclaw.local",
        agentId: "openclaw",
        gatewayToken: csprngId("oc_sess_", 20),
        authorityMode: "propose_with_approval",
        allowGatewayExecApprovals: false,
        enabledCollections: collections.map(c => c.slug),
      };
      await persistConnectionSettings(ctx, connection);
    }

    const enabledSlugs = connection
      ? collections.filter(c => connection.enabledCollections.includes(c.slug)).map(c => c.slug)
      : collections.map(c => c.slug);

    const agentId = connection?.agentId ?? "openclaw";
    const authorityMode = connection?.authorityMode ?? "read_only";
    const transportMode = connection ? classifyTransportMode(connection.gatewayUrl) : "paired-agent";

    if (connection && transportMode === "live-gateway" && role < ADMIN) {
      return {
        ok: false,
        error: "FORBIDDEN",
        message:
          "Administrator role is required to send prompts through an owner-authenticated HTTP(S) OpenClaw Gateway. Configure a Gateway WebSocket endpoint (ws:// or wss://) for Editor access.",
      };
    }

    if (/^\/?approve(?:@[^\s]+)?(?:\s|$)/i.test(prompt.trim())) {
      if (role < ADMIN) {
        return {
          ok: false,
          error: "GATEWAY_APPROVAL_FORBIDDEN",
          message: "Only EmDash Administrators can resolve OpenClaw Gateway execution approvals.",
        };
      }
      if (!connection?.allowGatewayExecApprovals) {
        return {
          ok: false,
          error: "GATEWAY_APPROVAL_DISABLED",
          message:
            "Inline Gateway approvals are disabled. Enable allowGatewayExecApprovals in Gateway settings or approve in OpenClaw Control UI.",
        };
      }
    }

    const now = new Date().toISOString();
    const userMsgId = csprngId("msg_u_", 6);
    const assistantMsgId = csprngId("msg_a_", 6);

    const userMsg: ChatTurnMessage = {
      messageId: userMsgId,
      role: "user",
      content: action === "steer_turn" ? `[Steer] ${prompt}` : prompt,
      createdAt: now,
      status: action === "steer_turn" ? "steered" : "completed",
    };
    const placeholderAssistantMsg: ChatTurnMessage = {
      messageId: assistantMsgId,
      role: "assistant",
      content: "",
      createdAt: now,
      status: "streaming",
    };

    const startedInfo = await mutateThreads(ctx, [], (current, protectedIds) => {
      const ensured = ensureUserThreads(
        current,
        currentUserId,
        agentId,
        collections,
        [],
        boundEntry,
        visitorHash,
      );
      const visible = ensured.threads.filter(t => isThreadVisibleToUser(t, currentUserId));
      const targetThread =
        (preferredConversationId
          ? visible.find(t => t.conversationId === preferredConversationId)
          : boundEntry
            ? visible.find(
                t =>
                  isOwnedPersonalThread(t, currentUserId) &&
                  t.boundEntry?.collection === boundEntry.collection &&
                  t.boundEntry?.entryId === boundEntry.entryId,
              )
            : undefined) ??
        visible.find(t => isOwnedPersonalThread(t, currentUserId)) ??
        visible[0]!;
      const targetConvId = targetThread.conversationId;
      const reboundTarget =
        action === "steer_turn" &&
        targetThread.status === "running" &&
        targetThread.sessionKey &&
        (!visitorHash ||
          targetThread.sessionKey.startsWith(
            `agent:${normalizeOpenClawAgentSegment(agentId)}:pg-${visitorHash}:`,
          ))
          ? targetThread
          : bindThreadToAgentSession(targetThread, agentId, undefined, visitorHash);
      const sessionKey =
        reboundTarget.sessionKey ?? buildCanonicalSessionKey(agentId, targetConvId, visitorHash);
      const switchedAgentSession = Boolean(
        action === "send_message" &&
          targetThread.messages.length > 0 &&
          targetThread.lastTurnSessionKey &&
          targetThread.lastTurnSessionKey !== sessionKey,
      );
      const next = ensured.threads.map(t => {
        if (t.conversationId !== targetConvId) return t;
        const autoTitle =
          t.messages.length === 0 && t.title === "New Store Conversation"
            ? prompt.slice(0, 42) + (prompt.length > 42 ? "…" : "")
            : t.title;
        return {
          ...t,
          sessionKey,
          ...(reboundTarget.agentSessionKeys
            ? { agentSessionKeys: reboundTarget.agentSessionKeys }
            : {}),
          title: autoTitle,
          status: "running" as const,
          updatedAt: now,
          messages: [...t.messages, userMsg, placeholderAssistantMsg],
        };
      });
      const retained = retainThreads(next, [
        ...protectedIds,
        targetConvId,
        ...ensured.addedIds,
        ...ensured.reboundIds,
      ]);
      return {
        threads: retained,
        result: {
          targetThread,
          targetConvId,
          sessionKey,
          switchedAgentSession,
          initialAudience: {
            ownerUserId: targetThread.ownerUserId ?? currentUserId,
            visibility: targetThread.visibility ?? ("personal" as const),
          },
        },
      };
    });

    const { targetThread, targetConvId, sessionKey, switchedAgentSession } = startedInfo;
    const readLiveAudience = async () =>
      resolveThreadAudience(await loadThreads(ctx), targetConvId, currentUserId);

    publishOpenClawEvent({
      type: "turn_started",
      conversationId: targetConvId,
      messageId: assistantMsgId,
      prompt,
      timestamp: now,
      ...startedInfo.initialAudience,
    });

    const toolCalls: ToolCallTrace[] = [];
    const gatheredEntries: CatalogEntrySummary[] = [];
    const effectiveBound = boundEntry ?? targetThread.boundEntry;

    if (effectiveBound && enabledSlugs.includes(effectiveBound.collection)) {
      const { item, durationMs } = await getSingleContentItem(
        ctx,
        effectiveBound.collection,
        effectiveBound.entryId,
        effectiveBound.locale,
      );
      const trace: ToolCallTrace = {
        callId: csprngId("call_get_", 4),
        name: "emdash.content.get",
        args: {
          collection: effectiveBound.collection,
          id: effectiveBound.entryId,
          ...(effectiveBound.locale ? { locale: effectiveBound.locale } : {}),
        },
        durationMs,
        status: item ? "ok" : "error",
        summary: item
          ? `Loaded ${item.collection}/${item.slug} (${item.status})`
          : `Entry ${effectiveBound.collection}/${effectiveBound.entryId} not found`,
        payload: item
          ? {
              id: item.id,
              slug: item.slug,
              title: item.title,
              status: item.status,
              version: item._rev,
              fields: Object.keys(item.fields),
            }
          : null,
      };
      toolCalls.push(trace);
      const toolAudience = await readLiveAudience();
      publishOpenClawEvent({
        type: "tool_call",
        conversationId: targetConvId,
        messageId: assistantMsgId,
        toolCall: trace,
        timestamp: new Date().toISOString(),
        ...toolAudience,
      });
      if (item) gatheredEntries.push(item);
    }

    const mentionedSlugs = enabledSlugs.filter(
      slug =>
        prompt.toLowerCase().includes(`@${slug.toLowerCase()}`) ||
        prompt.toLowerCase().includes(slug.toLowerCase()),
    );
    const slugsToQuery =
      mentionedSlugs.length > 0
        ? mentionedSlugs
        : enabledSlugs.includes("products")
          ? ["products", ...enabledSlugs.filter(s => s !== "products").slice(0, 2)]
          : enabledSlugs.slice(0, 3);

    for (const slug of slugsToQuery) {
      const { items, durationMs } = await listCollectionItems(ctx, slug, 12);
      for (const it of items) {
        if (!gatheredEntries.some(e => e.collection === it.collection && e.id === it.id)) {
          gatheredEntries.push(it);
        }
      }
      const trace: ToolCallTrace = {
        callId: csprngId(`call_${slug}_`, 4),
        name: "emdash.content.list",
        args: { collection: slug, limit: 12 },
        durationMs,
        status: "ok",
        summary: `${items.length} ${items.length === 1 ? "entry" : "entries"} in ${slug}`,
        payload: items.map(it => ({
          id: it.id,
          slug: it.slug,
          title: it.title,
          status: it.status,
          ...(it.priceSummary ? { price: it.priceSummary } : {}),
        })),
      };
      toolCalls.push(trace);
      const listAudience = await readLiveAudience();
      publishOpenClawEvent({
        type: "tool_call",
        conversationId: targetConvId,
        messageId: assistantMsgId,
        toolCall: trace,
        timestamp: new Date().toISOString(),
        ...listAudience,
      });
    }

    const catalogDigest = collections
      .filter(c => enabledSlugs.includes(c.slug))
      .map(c => {
        const colItems = gatheredEntries.filter(e => e.collection === c.slug);
        const lines = colItems
          .map(
            e =>
              `  - ${e.title} (collection="${e.collection}", id="${e.id}", slug="${e.slug}", status=${e.status}, fields=[${Object.keys(e.fields).join(",")}]${e.priceSummary ? `, price=${e.priceSummary}` : ""}${e.excerpt ? `, excerpt=${JSON.stringify(e.excerpt)}` : ""})`,
          )
          .join("\n");
        return `Collection "${c.label}" (${c.slug}): ${colItems.length} items\n${lines || "  (empty)"}`;
      })
      .join("\n\n");

    const proposalInstruction =
      authorityMode === "propose_with_approval"
        ? `\nAuthority: propose_with_approval (draft-only; never claim a CMS write was already applied). When proposing edits to an EmDash entry, include one \`\`\`emdash-proposal JSON block: {"collection":"...","entryId":"...","summary":"...","proposedFields":{"description":"..."}} using only draft-safe fields (title, excerpt, shortDescription, description, summary).`
        : `\nAuthority: read_only (inspect and answer only; do not emit emdash-proposal blocks).`;

    const createdProposals: RevisionProposal[] = [];
    const createdExecApprovals: GatewayExecApproval[] = [];
    let assistantReply = "";
    let turnFinalStatus: "completed" | "stopped" | "failed" = "completed";
    let gatewayRunId: string | undefined;

    const bridge = getHostGatewayBridge();

    // PATH A: Real OpenClaw Gateway v4 WebSocket RPC via @openclaw/gateway-client
    if (connection && transportMode === "gateway-ws") {
      if (!bridge) {
        assistantReply =
          "Gateway WebSocket URL is configured, but the host Node bridge (`openclawBridge()`) is not mounted in this profile.";
        turnFinalStatus = "failed";
      } else {
        const preSendAudience = await readLiveAudience();
        const priorContext = switchedAgentSession
          ? formatPriorConversationContext(targetThread.messages)
          : "";
        const gwResult = await bridge.sendTurn({
          connection,
          conversationId: targetConvId,
          ownerUserId: preSendAudience.ownerUserId,
          visibility: preSendAudience.visibility,
          resolveLatestAudience: readLiveAudience,
          messageId: assistantMsgId,
          sessionKey,
          prompt,
          systemContext: `${catalogDigest}${proposalInstruction}${priorContext}`,
          steer: action === "steer_turn",
          callerIsAdmin: role >= ADMIN,
          expectedRunId: targetThread.activeRunId,
          onDeviceCredentialsUpdated: patch =>
            persistIssuedDeviceCredentials(ctx, connection!.gatewayUrl, patch),
        });

        gatewayRunId = gwResult.runId;
        for (const gwTool of gwResult.toolCalls) {
          toolCalls.push(gwTool);
        }
        for (const gwApproval of gwResult.approvals) {
          createdExecApprovals.push(gwApproval);
        }
        if (createdExecApprovals.length > 0) {
          await upsertPersistedExecApprovals(ctx, createdExecApprovals);
        }

        if (!gwResult.ok && gwResult.status === "failed") {
          turnFinalStatus = "failed";
          const partialPrefix = gwResult.replyText.trim()
            ? `${gwResult.replyText.trim()}\n\n---\n`
            : "";
          assistantReply = `${partialPrefix}**OpenClaw Gateway Error:** ${gwResult.errorMessage ?? "Connection failed."}\n\nOpen **Gateway & Pairing** in the bottom-left sidebar to verify your Gateway WebSocket endpoint (\`ws://127.0.0.1:18789\` / \`ws://127.0.0.1:19301\` or \`wss://...\`) and token/device pairing.`;
        } else {
          turnFinalStatus = gwResult.status;
          if (action === "steer_turn" && !gwResult.replyText) {
            assistantReply = `Queued live mid-run steer onto Gateway session \`${sessionKey}\`.`;
          } else if (authorityMode === "propose_with_approval") {
            const parsed = parseGatewayAgentProposals(
              gwResult.replyText,
              gatheredEntries,
              targetConvId,
              agentId,
              gatewayRunId,
            );
            assistantReply = parsed.cleanedText;
            for (const p of parsed.proposals) {
              const targetEntry = gatheredEntries.find(
                e => e.collection === p.collection && e.id === p.entryId,
              );
              if (canCollectionStageDraft(collections, p.collection, targetEntry?.status ?? "published")) {
                createdProposals.push(p);
              }
            }
          } else {
            assistantReply = gwResult.replyText;
          }
        }
      }
    } else if (connection && transportMode === "live-gateway") {
      // PATH B1: Administrator-authenticated OpenClaw HTTP(S) `/v1/chat/completions` endpoint
      const httpResult = await tryExternalHttpGatewayTurn(ctx, connection, prompt, {
        userRole: role,
        sessionKey,
        priorMessages: targetThread.messages,
        systemContext: `${catalogDigest}${proposalInstruction}`,
        extraEnv,
        fromPlaygroundEnv: Boolean(connState.fromPlaygroundEnv),
      });

      if (!httpResult.ok || !httpResult.replyText) {
        turnFinalStatus = "failed";
        assistantReply = `**OpenClaw Gateway Error:** ${httpResult.errorMessage ?? "HTTP Gateway request failed."}\n\nOpen **Gateway & Pairing** in the bottom-left sidebar to verify your Gateway endpoint and token.`;
      } else if (authorityMode === "propose_with_approval") {
        const parsed = parseGatewayAgentProposals(
          httpResult.replyText,
          gatheredEntries,
          targetConvId,
          agentId,
          undefined,
        );
        assistantReply = parsed.cleanedText;
        for (const p of parsed.proposals) {
          const targetEntry = gatheredEntries.find(
            e => e.collection === p.collection && e.id === p.entryId,
          );
          if (canCollectionStageDraft(collections, p.collection, targetEntry?.status ?? "published")) {
            createdProposals.push(p);
          }
        }
      } else {
        assistantReply = httpResult.replyText;
      }

      if (assistantReply) {
        const httpAudience = await readLiveAudience();
        publishOpenClawEvent({
          type: "assistant_delta",
          conversationId: targetConvId,
          messageId: assistantMsgId,
          delta: assistantReply,
          content: assistantReply,
          timestamp: new Date().toISOString(),
          ...httpAudience,
        });
      }
    } else if (connection?.pairedAgentPoll && transportMode === "paired-agent") {
      // PATH B2a: Paired external agent polling `/_emdash/api/plugins/dinkus-openclaw/pair`
      const pairedSystemContext = `${catalogDigest}${proposalInstruction}${formatPriorConversationContext(targetThread.messages)}`;

      if (action === "steer_turn") {
        const steered = await steerPairedAgentTurn(ctx, targetConvId, prompt);
        if (steered) {
          const steerAck = `Queued mid-run steer onto active turn \`${steered.turnId}\` for @${agentId}.`;
          const steerThreads = await mutateThreads(ctx, [targetConvId], current => {
            const next = current.map(t => {
              if (t.conversationId !== targetConvId) return t;
              const messages = t.messages.map(m =>
                m.messageId === assistantMsgId
                  ? {
                      ...m,
                      content: steerAck,
                      status: "completed" as const,
                      toolCalls,
                    }
                  : m,
              );
              const stillStreaming = messages.some(m => m.status === "streaming");
              return {
                ...t,
                sessionKey,
                lastTurnSessionKey: sessionKey,
                status: stillStreaming ? ("running" as const) : ("idle" as const),
                ...(stillStreaming
                  ? { activeRunId: steered.turnId, runPhase: "awaiting_paired_agent" }
                  : { activeRunId: undefined, runPhase: undefined }),
                updatedAt: new Date().toISOString(),
                messages,
              };
            });
            return { threads: next, result: next };
          });
          const steerAud = resolveThreadAudience(steerThreads, targetConvId, currentUserId);
          const steerTs = new Date().toISOString();
          publishOpenClawEvent({
            type: "assistant_delta",
            conversationId: targetConvId,
            messageId: assistantMsgId,
            delta: steerAck,
            content: steerAck,
            timestamp: steerTs,
            ...steerAud,
          });
          publishOpenClawEvent({
            type: "workspace_sync",
            conversationId: targetConvId,
            reason: "turn_steered",
            timestamp: steerTs,
            ...steerAud,
          });
          return (await buildWorkspaceSnapshot(
            route,
            ctx,
            targetConvId,
            boundEntry,
          )) as unknown as Record<string, unknown>;
        }
      }

      const turnId = csprngId("turn_", 8);
      const liveAud = await readLiveAudience();
      const enqueueRes = await enqueuePairedAgentTurn(ctx, {
        turnId,
        conversationId: targetConvId,
        assistantMessageId: assistantMsgId,
        sessionKey,
        agentId,
        ownerUserId: liveAud.ownerUserId,
        visibility: liveAud.visibility,
        requestedByUserId: currentUserId,
        requestedByRole: role,
        prompt,
        systemContext: pairedSystemContext,
        gatheredSnapshot: gatheredEntries.slice(0, 24),
        status: "running",
        lastUpdate: `Waiting for paired agent @${agentId} to poll and complete turn.`,
        createdAt: now,
      });

      if (!enqueueRes.queued) {
        turnFinalStatus = "failed";
        assistantReply =
          enqueueRes.error ?? "Could not queue turn for the paired OpenClaw agent.";
      } else {
        const queuedOutcome = await mutateThreads(ctx, [targetConvId], current => {
          let stoppedDuringSetup = false;
          const next = current.map(t => {
            if (t.conversationId !== targetConvId) return t;
            const placeholder = t.messages.find(m => m.messageId === assistantMsgId);
            if (t.status === "stopped" || placeholder?.status === "stopped") {
              stoppedDuringSetup = true;
              return t;
            }
            return {
              ...t,
              sessionKey,
              lastTurnSessionKey: sessionKey,
              status: "running" as const,
              activeRunId: turnId,
              runPhase: "awaiting_paired_agent",
              updatedAt: new Date().toISOString(),
              messages: t.messages.map(m =>
                m.messageId === assistantMsgId
                  ? {
                      ...m,
                      runId: turnId,
                      toolCalls,
                    }
                  : m,
              ),
            };
          });
          return { threads: next, result: { stoppedDuringSetup, threads: next } };
        });

        if (queuedOutcome.stoppedDuringSetup) {
          await stopPairedAgentTurns(ctx, targetConvId);
        } else {
          const queuedAud = resolveThreadAudience(
            queuedOutcome.threads,
            targetConvId,
            currentUserId,
          );
          publishOpenClawEvent({
            type: "workspace_sync",
            conversationId: targetConvId,
            reason: "paired_turn_queued",
            timestamp: new Date().toISOString(),
            ...queuedAud,
          });
        }

        return (await buildWorkspaceSnapshot(
          route,
          ctx,
          targetConvId,
          boundEntry,
        )) as unknown as Record<string, unknown>;
      }
    } else {
      // PATH B2b: Built-in EmDash Store Inspector (local preview before pairing)
      const isMutationIntent =
        /^\/propose\b/i.test(prompt) ||
        /\b(update|edit|change|rewrite|improve|tighten|draft|propose|rename|description|excerpt|copy|headline|tagline)\b/i.test(
          prompt,
        );

      let matchedEntry: CatalogEntrySummary | undefined = effectiveBound
        ? gatheredEntries.find(
            e => e.collection === effectiveBound.collection && e.id === effectiveBound.entryId,
          )
        : undefined;
      if (!matchedEntry && gatheredEntries.length > 0) {
        const lowerPrompt = prompt.toLowerCase();
        matchedEntry =
          gatheredEntries.find(
            e =>
              lowerPrompt.includes(e.title.toLowerCase()) ||
              lowerPrompt.includes(e.slug.toLowerCase()),
          ) ?? gatheredEntries[0];
      }

      const canStageMatchedDraft = matchedEntry
        ? canCollectionStageDraft(collections, matchedEntry.collection, matchedEntry.status)
        : true;

      if (
        isMutationIntent &&
        matchedEntry &&
        authorityMode === "propose_with_approval" &&
        canStageMatchedDraft
      ) {
        const cleanPrompt = prompt.replace(/^\/propose\s*/i, "").trim() || "Refine copy";
        const proposal = buildSmartFieldProposal(
          matchedEntry,
          cleanPrompt,
          targetConvId,
          agentId,
        );
        if (proposal) {
          createdProposals.push(proposal);
        }
      }

      if (isMutationIntent && authorityMode === "read_only") {
        assistantReply = [
          `I inspected **${matchedEntry?.title ?? "your store content"}**, but \`@${agentId}\` is currently in **Read-Only** authority mode.`,
          ``,
          `Switch authority to **Read + Propose (\`propose_with_approval\`)** in the composer bar or **Customizations** to queue a revision-fenced EmDash draft card — I never write directly to your database without your approval.`,
        ].join("\n");
      } else if (
        isMutationIntent &&
        matchedEntry &&
        authorityMode === "propose_with_approval" &&
        !canStageMatchedDraft
      ) {
        assistantReply = [
          `I inspected **${matchedEntry.title}** (\`${matchedEntry.collection}/${matchedEntry.slug}\`), which is currently \`${matchedEntry.status}\`.`,
          ``,
          `Collection \`${matchedEntry.collection}\` does not have \`revisions\` enabled, so staging a draft save would modify live content immediately. Enable \`revisions\` on \`${matchedEntry.collection}\` or edit this entry directly in EmDash Admin.`,
        ].join("\n");
      } else if (createdProposals.length > 0 && matchedEntry) {
        const prop = createdProposals[0]!;
        assistantReply = [
          `Prepared a revision-guarded draft proposal (\`rev #${prop.revisionNumber}\`) for **${matchedEntry.title}** (\`${matchedEntry.collection}/${matchedEntry.slug}\`).`,
          ``,
          `- **Target fields:** ${prop.diffs.map(d => `\`${d.field}\``).join(", ")}`,
          `- **Concurrency fence:** Bound to saved EmDash \`_rev\` — if another editor saves first, EmDash will surface a conflict instead of overwriting their work.`,
          ``,
          `Review the diff card below (or inspect it in **Overview → Review Proposals**) and click **Approve & Save Draft** when ready.`,
        ].join("\n");
      } else if (gatheredEntries.length > 0) {
        const byCollection = slugsToQuery
          .map(slug => {
            const col = collections.find(c => c.slug === slug);
            const items = gatheredEntries.filter(e => e.collection === slug);
            if (items.length === 0) return `### ${col?.label ?? slug} (\`0\`)\n_No entries yet._`;
            return [
              `### ${col?.label ?? slug} (\`${items.length}\`)`,
              ...items.map(
                item =>
                  `- **${item.title}** (\`/${item.collection}/${item.slug}\`) — \`${item.status}\`${item.priceSummary ? ` · **${item.priceSummary}**` : ""}${item.excerpt ? `\n  ${item.excerpt}` : ""}`,
              ),
            ].join("\n");
          })
          .join("\n\n");

        assistantReply = [
          `Yes — I have live \`content:read\` access to **${enabledSlugs.length}** collection${enabledSlugs.length === 1 ? "" : "s"} (${enabledSlugs.map(s => `\`${s}\``).join(", ")}). Here is what is currently in your store:`,
          ``,
          byCollection,
          ``,
          authorityMode === "propose_with_approval"
            ? `Ask me to refine any entry's copy, excerpt, or title (or type \`/propose\`) and I'll stage a revision-guarded draft card for your approval.`
            : `Currently in **Read-Only** mode — switch to **Read + Propose** in the toolbar below whenever you want me to stage draft edits.`,
        ].join("\n");
      } else {
        assistantReply = [
          `Connected to collections ${enabledSlugs.map(s => `\`${s}\``).join(", ")}, which currently have **0 entries**.`,
          ``,
          `Create a first entry in EmDash Admin or enable additional collections under **Customizations** in the left sidebar.`,
        ].join("\n");
      }

      const streamAudience = await readLiveAudience();
      const chunks = assistantReply.match(/.{1,80}(\s|$)/gs) ?? [assistantReply];
      let acc = "";
      for (const chunk of chunks) {
        acc += chunk;
        publishOpenClawEvent({
          type: "assistant_delta",
          conversationId: targetConvId,
          messageId: assistantMsgId,
          delta: chunk,
          content: acc,
          timestamp: new Date().toISOString(),
          ...streamAudience,
        });
      }
    }

    for (let i = 0; i < createdProposals.length; i++) {
      const check = await doesStoredEntryMatchProposalBase(ctx, createdProposals[i]!);
      if (check.checked && !check.matches) {
        createdProposals[i] = {
          ...createdProposals[i]!,
          status: "conflict",
          conflictRev: check.item?._rev,
          errorMessage:
            "Entry changed while the agent turn was running. Rebase or regenerate before saving.",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    const assistantMsg: ChatTurnMessage = {
      messageId: assistantMsgId,
      runId: gatewayRunId,
      role: "assistant",
      content: assistantReply,
      createdAt: new Date().toISOString(),
      status: turnFinalStatus,
      toolCalls,
      proposalIds: createdProposals.map(p => p.proposalId),
      execApprovalIds: createdExecApprovals.map(a => a.approvalId),
    };

    if (createdProposals.length > 0) {
      await loadRevisionProposals(ctx);
      await withOpenClawStorageLock("proposals", async () => {
        const fresh = ctx.kv
          ? normalizeV2Proposals(await ctx.kv.get("revision_proposals_v2"))
          : [];
        await saveRevisionProposals(ctx, [...createdProposals, ...fresh]);
      });
    }

    const latestPostTurnConn = await readConnectionSettings(ctx, extraEnv);
    const postTurnAgentId = latestPostTurnConn?.agentId ?? agentId;

    const updatedThreads = await mutateThreads(ctx, [targetConvId], current => {
      const hasTarget = current.some(t => t.conversationId === targetConvId);
      const source = hasTarget ? current : [{ ...targetThread, messages: [userMsg] }, ...current];
      const next = source.map(t => {
        if (t.conversationId !== targetConvId) return t;
        const hasPlaceholder = t.messages.some(m => m.messageId === assistantMsgId);
        const mergedAssistant: ChatTurnMessage =
          t.status === "stopped" && turnFinalStatus === "completed" && !assistantReply
            ? { ...assistantMsg, status: "stopped" }
            : assistantMsg;
        const nextMessages = hasPlaceholder
          ? t.messages.map(m => (m.messageId === assistantMsgId ? mergedAssistant : m))
          : [...t.messages, userMsg, mergedAssistant];
        const stillStreaming = nextMessages.some(m => m.status === "streaming");
        const nextStatus = stillStreaming
          ? ("running" as const)
          : turnFinalStatus === "failed"
            ? ("failed" as const)
            : turnFinalStatus === "stopped" || t.status === "stopped"
              ? ("stopped" as const)
              : ("idle" as const);
        const withTurnBinding: ConversationThread = {
          ...t,
          sessionKey,
          ...(turnFinalStatus !== "failed" ? { lastTurnSessionKey: sessionKey } : {}),
          status: nextStatus,
          ...(stillStreaming ? {} : { activeRunId: undefined, runPhase: undefined }),
          updatedAt: new Date().toISOString(),
          messages: nextMessages,
        };
        return stillStreaming
          ? withTurnBinding
          : bindThreadToAgentSession(withTurnBinding, postTurnAgentId, undefined, visitorHash);
      });
      return { threads: next, result: next };
    });

    const finalAudience = resolveThreadAudience(updatedThreads, targetConvId, currentUserId);

    if (createdProposals.length > 0) {
      for (const proposal of createdProposals) {
        publishOpenClawEvent({
          type: "proposal_updated",
          proposal,
          timestamp: new Date().toISOString(),
          ...finalAudience,
        });
      }
    }

    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: targetConvId,
      reason: "turn_completed",
      timestamp: new Date().toISOString(),
      ...finalAudience,
    });

    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      targetConvId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  return (await buildWorkspaceSnapshot(
    route,
    ctx,
    preferredConversationId,
    boundEntry,
  )) as unknown as Record<string, unknown>;
}

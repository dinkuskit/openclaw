import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { getHostGatewayBridge } from "./gateway-bridge-registry.js";
import type {
  AutomationRule,
  BoundEntryRef,
  CatalogEntrySummary,
  ChatTurnMessage,
  ContentFieldDiff,
  ConversationThread,
  GatewayApprovalDecision,
  GatewayBridgeStatus,
  GatewayExecApproval,
  OpenClawConnection,
  OpenClawWorkspaceSnapshot,
  ProposalLifecycleStatus,
  RevisionProposal,
  SiteCollectionSummary,
  ToolCallTrace,
} from "./protocol.js";
import { publishOpenClawEvent } from "./sse-bus.js";

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
        fields?: Array<{ name?: string; slug?: string; type?: string; label?: string }>;
      }>
    >;
    getCollection?: (slug: string) => Promise<{
      slug: string;
      label?: string;
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
    `2. Use the returned sessionToken (Authorization: Bearer <sessionToken>) with MCP / REST at:`,
    `   ${pairEndpoint}`,
  ].join("\n");
}

export async function getOrCreatePairingCode(ctx: PluginContext): Promise<string> {
  if (!ctx.kv) return csprngId("oc_pair_", 12);
  const existing = await ctx.kv.get("pairing_code");
  const expiresAt = await ctx.kv.get("pairing_code_expires_at");
  const validExpiry = typeof expiresAt !== "number" || expiresAt > Date.now();
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

export async function readConnectionSettings(ctx: PluginContext): Promise<OpenClawConnection | null> {
  let raw: unknown;
  try {
    raw = await ctx.settings.get("connection");
  } catch {
    await ctx.settings.delete("connection").catch(() => {});
    return null;
  }
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OpenClawConnection>;
    if (
      typeof parsed.gatewayUrl === "string" &&
      isSupportedGatewayUrl(parsed.gatewayUrl) &&
      typeof parsed.agentId === "string" &&
      parsed.agentId.length > 0 &&
      typeof parsed.gatewayToken === "string" &&
      parsed.gatewayToken.length > 0
    ) {
      return {
        gatewayUrl: parsed.gatewayUrl,
        agentId: parsed.agentId,
        gatewayToken: parsed.gatewayToken,
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
        allowGatewayExecApprovals: parsed.allowGatewayExecApprovals === true,
        enabledCollections: Array.isArray(parsed.enabledCollections)
          ? parsed.enabledCollections.filter((item): item is string => typeof item === "string")
          : ["pages", "products"],
      };
    }
  } catch {
    // Malformed settings require re-pairing.
  }
  return null;
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

export async function listSiteCollections(
  ctx: PluginContext,
): Promise<SiteCollectionSummary[]> {
  const ext = ctx as unknown as ExtendedPluginContext;
  try {
    if (ext.schema?.listCollections) {
      const cols = await ext.schema.listCollections();
      if (Array.isArray(cols) && cols.length > 0) {
        return cols.map(col => ({
          slug: col.slug,
          label: col.label ?? col.name ?? col.slug,
        }));
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

async function loadThreads(ctx: PluginContext): Promise<ConversationThread[]> {
  if (!ctx.kv) return [];
  const raw = await ctx.kv.get("chat_threads_v2");
  if (!Array.isArray(raw)) return [];
  return raw as ConversationThread[];
}

async function saveThreads(ctx: PluginContext, threads: ConversationThread[]): Promise<void> {
  if (!ctx.kv) return;
  await ctx.kv.set("chat_threads_v2", threads.slice(0, 60));
}

function isThreadVisibleToUser(thread: ConversationThread, userId: string): boolean {
  if (thread.visibility === "shared") return true;
  if (!thread.ownerUserId) return true;
  return thread.ownerUserId === userId;
}

export async function loadRevisionProposals(ctx: PluginContext): Promise<RevisionProposal[]> {
  if (!ctx.kv) return [];
  const v2 = await ctx.kv.get("revision_proposals_v2");
  if (Array.isArray(v2)) {
    return (v2 as RevisionProposal[]).map(p => ({
      ...p,
      revisionNumber: typeof p.revisionNumber === "number" ? p.revisionNumber : 1,
    }));
  }

  const legacy = await ctx.kv.get("pending_proposals");
  if (Array.isArray(legacy) && legacy.length > 0) {
    const migrated: RevisionProposal[] = legacy.map((item: Record<string, unknown>, idx) => ({
      proposalId: typeof item.proposalId === "string" ? item.proposalId : `prop_legacy_${idx}`,
      revisionNumber: 1,
      conversationId: "conv_catalog_overview",
      agentId: typeof item.agentId === "string" ? item.agentId : "openclaw",
      collection: typeof item.collection === "string" ? item.collection : "pages",
      entryId: typeof item.entryId === "string" ? item.entryId : "current",
      entrySlug: typeof item.entryId === "string" ? item.entryId : "current",
      entryTitle: typeof item.entryId === "string" ? item.entryId : "Store Entry",
      baseRev: "pending-browser-rev",
      summary: typeof item.summary === "string" ? item.summary : "Proposed content change",
      targetTool: typeof item.targetTool === "string" ? item.targetTool : "content:update",
      proposedFields: {},
      diffs: [
        {
          field: "summary",
          label: "Proposed Change",
          before: "(current saved content)",
          after: typeof item.summary === "string" ? item.summary : "Proposed update",
          addedLines: 1,
          removedLines: 0,
        },
      ],
      status: "pending",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await ctx.kv.set("revision_proposals_v2", migrated);
    return migrated;
  }
  return [];
}

export async function saveRevisionProposals(
  ctx: PluginContext,
  proposals: RevisionProposal[],
): Promise<void> {
  if (!ctx.kv) return;
  await ctx.kv.set("revision_proposals_v2", proposals.slice(0, 80));
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
  await ctx.kv.set("gateway_exec_approvals_v1", approvals.slice(0, 50));
}

async function mergeExecApprovals(ctx: PluginContext): Promise<GatewayExecApproval[]> {
  const persisted = await loadPersistedExecApprovals(ctx);
  const bridge = getHostGatewayBridge();
  const live = bridge ? bridge.listLiveApprovals() : [];
  if (live.length === 0) return persisted;
  const byId = new Map<string, GatewayExecApproval>();
  for (const item of persisted) byId.set(item.approvalId, item);
  for (const item of live) byId.set(item.approvalId, item);
  const merged = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await savePersistedExecApprovals(ctx, merged);
  return merged;
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

async function tryExternalHttpGatewayTurn(
  ctx: PluginContext,
  connection: OpenClawConnection,
  prompt: string,
  catalogSummaryText: string,
): Promise<string | null> {
  if (
    !connection.gatewayUrl ||
    connection.gatewayUrl === "https://agent-session.openclaw.local" ||
    connection.gatewayUrl.startsWith("ws://") ||
    connection.gatewayUrl.startsWith("wss://")
  ) {
    return null;
  }
  const base = connection.gatewayUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1/chat/completions")
    ? base
    : `${base}/v1/chat/completions`;
  if (!ctx.http) return null;
  try {
    const response = await ctx.http.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.gatewayToken}`,
      },
      body: JSON.stringify({
        model: `openclaw:${connection.agentId}`,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              `You are @${connection.agentId}, connected to an EmDash CMS store (${connection.authorityMode}). ` +
              `Ground every answer strictly in the live EmDash collections below:\n${catalogSummaryText}`,
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      reply?: string;
    };
    const content = json.choices?.[0]?.message?.content ?? json.reply;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch {
    return null;
  }
}

function buildCanonicalSessionKey(agentId: string, conversationId: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "") || "openclaw";
  const safeConv = conversationId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `agent:${safeAgent}:emdash:${safeConv}`;
}

function ensureUserThreads(
  allThreads: ConversationThread[],
  currentUserId: string,
  agentId: string,
  collections: SiteCollectionSummary[],
  entriesPreview: CatalogEntrySummary[],
  boundEntry?: BoundEntryRef,
): ConversationThread[] {
  let next = [...allThreads];

  if (boundEntry) {
    const existingBound = next.find(
      t =>
        isThreadVisibleToUser(t, currentUserId) &&
        t.boundEntry?.collection === boundEntry.collection &&
        t.boundEntry?.entryId === boundEntry.entryId,
    );
    if (!existingBound) {
      const now = new Date().toISOString();
      const matched = entriesPreview.find(
        e => e.collection === boundEntry.collection && e.id === boundEntry.entryId,
      );
      const convId = `conv_entry_${currentUserId}_${boundEntry.collection}_${boundEntry.entryId}`;
      next = [
        {
          conversationId: convId,
          ownerUserId: currentUserId,
          visibility: "personal",
          sessionKey: buildCanonicalSessionKey(agentId, convId),
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

  const visible = next.filter(t => isThreadVisibleToUser(t, currentUserId));
  if (visible.length === 0) {
    const now = new Date().toISOString();
    const hasProducts = collections.some(c => c.slug === "products");
    const convId =
      currentUserId === "u1" || currentUserId === "dev-admin"
        ? "conv_catalog_overview"
        : `conv_${currentUserId}_overview`;
    next.push({
      conversationId: convId,
      ownerUserId: currentUserId,
      visibility: "personal",
      sessionKey: buildCanonicalSessionKey(agentId, convId),
      title: hasProducts ? "Catalog & Products Overview" : "Site Content Overview",
      scopeGroup: hasProducts ? "products" : "pages & storefront",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
  }
  return next;
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
  const pairingCode = await getOrCreatePairingCode(ctx);
  const connection = await readConnectionSettings(ctx);
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
  allThreads = ensureUserThreads(
    allThreads,
    currentUserId,
    agentId,
    enrichedCollections,
    entriesPreview,
    boundEntry,
  );
  await saveThreads(ctx, allThreads);

  const visibleThreads = allThreads.filter(t => isThreadVisibleToUser(t, currentUserId));
  const visibleConvIds = new Set(visibleThreads.map(t => t.conversationId));

  const allProposals = await loadRevisionProposals(ctx);
  const visibleProposals = allProposals.filter(
    p => visibleConvIds.has(p.conversationId) || p.conversationId === "conv_default",
  );

  const allExecApprovals = await mergeExecApprovals(ctx);
  const visibleApprovals = allExecApprovals.filter(
    a => visibleConvIds.has(a.conversationId) || a.conversationId === "conv_catalog_overview",
  );

  const automations = await loadAutomations(ctx, enrichedCollections);

  let activeConversationId = preferredConversationId;
  if (boundEntry && !activeConversationId) {
    activeConversationId = visibleThreads.find(
      t =>
        t.boundEntry?.collection === boundEntry.collection &&
        t.boundEntry?.entryId === boundEntry.entryId,
    )?.conversationId;
  }
  if (
    !activeConversationId ||
    !visibleThreads.some(t => t.conversationId === activeConversationId)
  ) {
    activeConversationId = visibleThreads[0]!.conversationId;
  }

  const bridge = getHostGatewayBridge();
  const gatewayBridge: GatewayBridgeStatus = bridge
    ? bridge.getStatus(connection)
    : {
        available: false,
        state: "disconnected",
        grantedScopes: [],
      };

  const canResolveGatewayApprovals =
    isAdmin &&
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
    pairingCommand: buildPairingCommandString(siteOrigin, pairingCode),
    pairingPrompt: buildPairingPromptString(siteOrigin, pairingCode),
    connection: connection
      ? {
          gatewayUrl: connection.gatewayUrl,
          agentId: connection.agentId,
          authorityMode: connection.authorityMode,
          allowGatewayExecApprovals: Boolean(connection.allowGatewayExecApprovals),
          enabledCollections: connection.enabledCollections,
          transportMode: classifyTransportMode(connection.gatewayUrl),
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
  for (const [key, expectedVal] of Object.entries(proposal.proposedFields)) {
    if (typeof expectedVal === "string" && item.fields[key] !== expectedVal) {
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

  if (action === "get_workspace") {
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
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

  if (action === "configure_connection" && role >= ADMIN) {
    const existing = await readConnectionSettings(ctx);
    const collections = await listSiteCollections(ctx);
    const bridge = getHostGatewayBridge();

    const rawGatewayUrl =
      cleanInputText(input.gatewayUrl, 400) ??
      existing?.gatewayUrl ??
      "https://agent-session.openclaw.local";
    const rawToken = cleanInputText(input.gatewayToken, 400);

    let gatewayUrl = rawGatewayUrl;
    let extractedToken = rawToken;

    if (bridge && rawGatewayUrl !== "https://agent-session.openclaw.local") {
      const normalized = bridge.normalizeGatewayInput(rawGatewayUrl, rawToken);
      if (!normalized.ok) {
        return {
          ok: false,
          error: "INVALID_GATEWAY_URL",
          message: normalized.error ?? "Invalid OpenClaw Gateway URL.",
        };
      }
      if (normalized.wsUrl) {
        gatewayUrl = normalized.wsUrl;
      }
      if (normalized.extractedToken) {
        extractedToken = normalized.extractedToken;
      }
    }

    const agentId = cleanInputText(input.agentId, 80) ?? existing?.agentId ?? "openclaw";
    const gatewayToken =
      extractedToken ?? existing?.gatewayToken ?? csprngId("oc_sess_", 20);
    const authorityMode =
      input.authorityMode === "read_only"
        ? "read_only"
        : input.authorityMode === "propose_with_approval"
          ? "propose_with_approval"
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

    const updated: OpenClawConnection = {
      gatewayUrl,
      agentId,
      gatewayToken,
      ...(existing?.deviceToken ? { deviceToken: existing.deviceToken } : {}),
      ...(deviceIdentity ? { deviceIdentity } : {}),
      authorityMode,
      allowGatewayExecApprovals,
      enabledCollections,
    };
    await persistConnectionSettings(ctx, updated);

    if (bridge && classifyTransportMode(gatewayUrl) === "gateway-ws") {
      await bridge.connect(updated, async patch => {
        const latest = (await readConnectionSettings(ctx)) ?? updated;
        await persistConnectionSettings(ctx, {
          ...latest,
          ...(patch.deviceIdentity ? { deviceIdentity: patch.deviceIdentity } : {}),
          ...(patch.deviceToken ? { deviceToken: patch.deviceToken } : {}),
        });
      });
    } else if (bridge) {
      await bridge.disconnect();
    }

    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: preferredConversationId ?? "conv_catalog_overview",
      reason: "connection_updated",
      timestamp: new Date().toISOString(),
    });
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "probe_gateway" && role >= ADMIN) {
    const connection = await readConnectionSettings(ctx);
    const bridge = getHostGatewayBridge();
    if (connection && bridge && classifyTransportMode(connection.gatewayUrl) === "gateway-ws") {
      await bridge.connect(connection, async patch => {
        const latest = (await readConnectionSettings(ctx)) ?? connection;
        await persistConnectionSettings(ctx, {
          ...latest,
          ...(patch.deviceIdentity ? { deviceIdentity: patch.deviceIdentity } : {}),
          ...(patch.deviceToken ? { deviceToken: patch.deviceToken } : {}),
        });
      });
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
    const automations = await loadAutomations(ctx, collections);
    const next = automations.map(rule =>
      rule.automationId === automationId ? { ...rule, enabled: !rule.enabled } : rule,
    );
    if (ctx.kv) {
      await ctx.kv.set("openclaw_automations_v1", next);
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "create_thread") {
    const connection = await readConnectionSettings(ctx);
    const collections = await listSiteCollections(ctx);
    const threads = await loadThreads(ctx);
    const title = cleanInputText(input.title, 120) ?? "New Store Conversation";
    const visibility = input.visibility === "shared" ? "shared" : "personal";
    const scopeGroup =
      cleanInputText(input.scopeGroup, 60) ??
      (collections.some(c => c.slug === "products") ? "products" : "pages & storefront");
    const now = new Date().toISOString();
    const convId = csprngId("conv_", 8);
    const newThread: ConversationThread = {
      conversationId: convId,
      ownerUserId: currentUserId,
      visibility,
      sessionKey: buildCanonicalSessionKey(connection?.agentId ?? "openclaw", convId),
      title,
      scopeGroup,
      boundEntry,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await saveThreads(ctx, [newThread, ...threads]);
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
      const threads = await loadThreads(ctx);
      const next = threads.map(t => {
        if (t.conversationId !== targetId) return t;
        if (t.ownerUserId && t.ownerUserId !== currentUserId && role < ADMIN) return t;
        const nextVis: "personal" | "shared" =
          t.visibility === "shared" ? "personal" : "shared";
        return { ...t, visibility: nextVis, updatedAt: new Date().toISOString() };
      });
      await saveThreads(ctx, next);
    }
    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "stamp_proposal_rev") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const baseRev = cleanInputText(input.baseRev, 240);
    if (proposalId && baseRev) {
      const proposals = await loadRevisionProposals(ctx);
      const next = proposals.map(p =>
        p.proposalId === proposalId &&
        (p.baseRev === "pending-browser-rev" || p.baseRev.startsWith("v"))
          ? { ...p, baseRev, updatedAt: new Date().toISOString() }
          : p,
      );
      await saveRevisionProposals(ctx, next);
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
      const proposals = await loadRevisionProposals(ctx);
      const parent = proposals.find(p => p.proposalId === proposalId);
      if (parent && parent.status === "pending") {
        const sanitizedPatch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(editedFields)) {
          if (!EXCLUDED_DRAFT_ONLY_FIELDS.has(k) && typeof v === "string") {
            sanitizedPatch[k] = v;
          }
        }
        const now = new Date().toISOString();
        const nextProposalId = csprngId("prop_", 8);
        const mergedFields = { ...parent.proposedFields, ...sanitizedPatch };
        const nextDiffs = parent.diffs.map(d =>
          d.field in sanitizedPatch
            ? {
                ...d,
                after: sanitizedPatch[d.field] as string,
                ...countDiffLines(d.before, sanitizedPatch[d.field] as string),
              }
            : d,
        );
        const revised: RevisionProposal = {
          ...parent,
          proposalId: nextProposalId,
          revisionNumber: (parent.revisionNumber ?? 1) + 1,
          supersedesProposalId: parent.proposalId,
          proposedFields: mergedFields,
          diffs: nextDiffs,
          status: "pending",
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

        // Also attach the revised proposalId to the conversation turn so it stays inline in chat
        const threads = await loadThreads(ctx);
        const updatedThreads = threads.map(t => {
          if (t.conversationId !== parent.conversationId) return t;
          return {
            ...t,
            messages: t.messages.map(m =>
              m.proposalIds?.includes(parent.proposalId)
                ? {
                    ...m,
                    proposalIds: m.proposalIds.map(id =>
                      id === parent.proposalId ? nextProposalId : id,
                    ),
                  }
                : m,
            ),
          };
        });
        await saveThreads(ctx, updatedThreads);

        publishOpenClawEvent({
          type: "proposal_updated",
          proposal: revised,
          timestamp: now,
        });
        return {
          ...((await buildWorkspaceSnapshot(
            route,
            ctx,
            preferredConversationId,
            boundEntry,
          )) as unknown as Record<string, unknown>),
          revisedProposalId: nextProposalId,
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

  if (action === "record_proposal_receipt" || action === "reconcile_proposal") {
    const proposalId = cleanInputText(input.proposalId, 120);
    const statusRaw = cleanInputText(input.status, 40) as ProposalLifecycleStatus | undefined;
    const appliedRev = cleanInputText(input.appliedRev, 240);
    const conflictRev = cleanInputText(input.conflictRev, 240);
    const baseRev = cleanInputText(input.baseRev, 240);
    const errorMessage = cleanInputText(input.errorMessage, 400);

    if (proposalId) {
      const proposals = await loadRevisionProposals(ctx);
      const target = proposals.find(p => p.proposalId === proposalId);
      if (target) {
        let verifiedStatus: ProposalLifecycleStatus =
          action === "reconcile_proposal" ? target.status : (statusRaw ?? target.status);
        let reconciledServerSide = target.reconciledServerSide;
        let finalError = errorMessage;

        // Server-side content reconciliation: never trust a browser `applied` claim if stored CMS fields disagree,
        // and recover `outcome_unknown` automatically if the PUT landed before the network dropped!
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
            ...(appliedRev ? { appliedRev } : {}),
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
          });
        }
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
   * Dual-Authority Gateway Execution Approval resolution (Section 4):
   *CMS draft permission (`content:edit_any`) NEVER automatically grants Gateway
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

    const connection = await readConnectionSettings(ctx);
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
    if (!res.ok) {
      return {
        ok: false,
        error: "GATEWAY_APPROVAL_FAILED",
        message: res.error ?? "Gateway rejected approval resolution.",
      };
    }

    if (res.approval) {
      const persisted = await loadPersistedExecApprovals(ctx);
      const next = [
        res.approval,
        ...persisted.filter(a => a.approvalId !== res.approval!.approvalId),
      ];
      await savePersistedExecApprovals(ctx, next);
    }

    return (await buildWorkspaceSnapshot(
      route,
      ctx,
      preferredConversationId,
      boundEntry,
    )) as unknown as Record<string, unknown>;
  }

  if (action === "stop_turn") {
    const connection = await readConnectionSettings(ctx);
    const bridge = getHostGatewayBridge();
    const threads = await loadThreads(ctx);
    const target = threads.find(
      t =>
        isThreadVisibleToUser(t, currentUserId) &&
        (!preferredConversationId || t.conversationId === preferredConversationId),
    );
    if (
      target &&
      connection &&
      bridge &&
      classifyTransportMode(connection.gatewayUrl) === "gateway-ws"
    ) {
      await bridge.abortTurn({
        connection,
        sessionKey:
          target.sessionKey ?? buildCanonicalSessionKey(connection.agentId, target.conversationId),
        runId: target.activeRunId,
      });
    }

    const next = threads.map(t => {
      if (!isThreadVisibleToUser(t, currentUserId)) return t;
      if (preferredConversationId && t.conversationId !== preferredConversationId) return t;
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
    await saveThreads(ctx, next);
    if (ctx.kv) await ctx.kv.delete("active_turn");
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

    let connection = await readConnectionSettings(ctx);
    const collections = await listSiteCollections(ctx);
    if (!connection && role >= ADMIN) {
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

    const now = new Date().toISOString();
    const userMsgId = csprngId("msg_u_", 6);
    const assistantMsgId = csprngId("msg_a_", 6);

    let allThreads = await loadThreads(ctx);
    allThreads = ensureUserThreads(allThreads, currentUserId, agentId, collections, [], boundEntry);
    const visibleThreads = allThreads.filter(t => isThreadVisibleToUser(t, currentUserId));
    const targetThread =
      (preferredConversationId
        ? visibleThreads.find(t => t.conversationId === preferredConversationId)
        : undefined) ?? visibleThreads[0]!;
    const targetConvId = targetThread.conversationId;
    const sessionKey =
      targetThread.sessionKey ?? buildCanonicalSessionKey(agentId, targetConvId);
    const audience = {
      ownerUserId: targetThread.ownerUserId,
      visibility: targetThread.visibility,
    };

    publishOpenClawEvent({
      type: "turn_started",
      conversationId: targetConvId,
      messageId: assistantMsgId,
      prompt,
      timestamp: now,
      ...audience,
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
      publishOpenClawEvent({
        type: "tool_call",
        conversationId: targetConvId,
        messageId: assistantMsgId,
        toolCall: trace,
        timestamp: new Date().toISOString(),
        ...audience,
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
      publishOpenClawEvent({
        type: "tool_call",
        conversationId: targetConvId,
        messageId: assistantMsgId,
        toolCall: trace,
        timestamp: new Date().toISOString(),
        ...audience,
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
        const gwResult = await bridge.sendTurn({
          connection,
          conversationId: targetConvId,
          ownerUserId: targetThread.ownerUserId,
          visibility: targetThread.visibility,
          messageId: assistantMsgId,
          sessionKey,
          prompt,
          systemContext: `${catalogDigest}${proposalInstruction}`,
          steer: action === "steer_turn",
          expectedRunId: targetThread.activeRunId,
          onDeviceCredentialsUpdated: async patch => {
            const latest = (await readConnectionSettings(ctx)) ?? connection!;
            await persistConnectionSettings(ctx, {
              ...latest,
              ...(patch.deviceIdentity ? { deviceIdentity: patch.deviceIdentity } : {}),
              ...(patch.deviceToken ? { deviceToken: patch.deviceToken } : {}),
            });
          },
        });

        gatewayRunId = gwResult.runId;
        for (const gwTool of gwResult.toolCalls) {
          toolCalls.push(gwTool);
        }
        for (const gwApproval of gwResult.approvals) {
          createdExecApprovals.push(gwApproval);
        }
        if (createdExecApprovals.length > 0) {
          const persisted = await loadPersistedExecApprovals(ctx);
          const byId = new Map(persisted.map(a => [a.approvalId, a]));
          for (const a of createdExecApprovals) byId.set(a.approvalId, a);
          await savePersistedExecApprovals(ctx, [...byId.values()]);
        }

        if (!gwResult.ok && gwResult.status === "failed") {
          turnFinalStatus = "failed";
          assistantReply = `**OpenClaw Gateway Error:** ${gwResult.errorMessage ?? "Connection failed."}\n\nOpen **Gateway & Pairing** in the bottom-left sidebar to verify your Gateway WebSocket endpoint (\`ws://127.0.0.1:18789\` / \`ws://127.0.0.1:19301\` or \`wss://...\`) and token/device pairing.`;
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
              createdProposals.push(p);
            }
          } else {
            assistantReply = gwResult.replyText;
          }
        }
      }
    } else {
      // PATH B: Optional HTTPS completions endpoint OR Built-in EmDash Store Inspector
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

      if (isMutationIntent && matchedEntry && authorityMode === "propose_with_approval") {
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

      const httpReply = connection
        ? await tryExternalHttpGatewayTurn(ctx, connection, prompt, catalogDigest)
        : null;

      if (httpReply) {
        assistantReply = httpReply;
      } else if (isMutationIntent && authorityMode === "read_only") {
        assistantReply = [
          `I inspected **${matchedEntry?.title ?? "your store content"}**, but \`@${agentId}\` is currently in **Read-Only** authority mode.`,
          ``,
          `Switch authority to **Read + Propose (\`propose_with_approval\`)** in the composer bar or **Customizations** to queue a revision-fenced EmDash draft card — I never write directly to your database without your approval.`,
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
          ...audience,
        });
      }
    }

    if (createdProposals.length > 0) {
      const existingProposals = await loadRevisionProposals(ctx);
      await saveRevisionProposals(ctx, [...createdProposals, ...existingProposals]);
      for (const proposal of createdProposals) {
        publishOpenClawEvent({
          type: "proposal_updated",
          proposal,
          timestamp: new Date().toISOString(),
          ...audience,
        });
      }
    }

    const userMsg: ChatTurnMessage = {
      messageId: userMsgId,
      role: "user",
      content: action === "steer_turn" ? `[Steer] ${prompt}` : prompt,
      createdAt: now,
      status: action === "steer_turn" ? "steered" : "completed",
    };

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

    const updatedThreads = allThreads.map(t => {
      if (t.conversationId !== targetConvId) return t;
      const autoTitle =
        t.messages.length === 0 && t.title === "New Store Conversation"
          ? prompt.slice(0, 42) + (prompt.length > 42 ? "…" : "")
          : t.title;
      return {
        ...t,
        sessionKey,
        title: autoTitle,
        status: turnFinalStatus === "failed" ? ("failed" as const) : ("idle" as const),
        activeRunId: undefined,
        runPhase: undefined,
        updatedAt: new Date().toISOString(),
        messages: [...t.messages, userMsg, assistantMsg],
      };
    });
    await saveThreads(ctx, updatedThreads);

    publishOpenClawEvent({
      type: "workspace_sync",
      conversationId: targetConvId,
      reason: "turn_completed",
      timestamp: new Date().toISOString(),
      ...audience,
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

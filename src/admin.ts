import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { publishOpenClawEvent, withOpenClawStorageLock } from "./sse-bus.js";

/** EmDash Editor role (40) and Administrator role (50). */
const EDITOR = 40;
const ADMIN = 50;

export interface OpenClawConnection {
  gatewayUrl: string;
  agentId: string;
  gatewayToken: string;
  authorityMode: "read_only" | "propose_with_approval";
  enabledCollections: string[];
}

export interface ActiveTurn {
  turnId: string;
  prompt: string;
  status: "running" | "steered" | "completed";
  lastUpdate: string;
}

export interface PendingProposal {
  proposalId: string;
  agentId: string;
  collection?: string;
  entryId?: string;
  summary: string;
  targetTool: string;
  proposedFields?: Record<string, string>;
  createdAt: string;
}

const EXCLUDED_EXTERNAL_PATCH_FIELDS = new Set([
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

function extractSafeExternalFields(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!EXCLUDED_EXTERNAL_PATCH_FIELDS.has(k) && typeof v === "string") {
      out[k] = v.slice(0, 4000);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface Action {
  type: "block_action";
  action_id: string;
  value?: unknown;
}
interface Submit {
  type: "form_submit";
  action_id: string;
  values: Record<string, unknown>;
}
type Interaction = { type: "page_load" } | { type: "panel_load" } | Action | Submit;

function parseInteraction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
  if (value.type === "panel_load") return { type: "panel_load" };
  if (value.type === "block_action" && typeof value.action_id === "string") {
    return { type: "block_action", action_id: value.action_id, value: value.value };
  }
  if (
    value.type === "form_submit" &&
    typeof value.action_id === "string" &&
    typeof value.values === "object" &&
    value.values !== null
  ) {
    return {
      type: "form_submit",
      action_id: value.action_id,
      values: value.values as Record<string, unknown>,
    };
  }
  return null;
}

function cleanText(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\r\n?/g, "\n").trim();
  return trimmed.length > 0 &&
    trimmed.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(trimmed)
    ? trimmed
    : undefined;
}

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const banner = (
  variant: "default" | "alert" | "error",
  title: string,
  description: string,
): Block => ({
  type: "banner",
  variant,
  title,
  description,
});
const fields = (...pairs: [string, string][]): Block => ({
  type: "fields",
  fields: pairs.map(([label, value]) => ({ label, value })),
});

async function discoverSiteCollections(
  ctx: PluginContext,
): Promise<Array<{ slug: string; label: string }>> {
  try {
    const schemaApi = (ctx as unknown as {
      schema?: { listCollections?: () => Promise<Array<{ slug: string; label?: string; name?: string }>> };
    }).schema;
    if (schemaApi?.listCollections) {
      const list = await schemaApi.listCollections();
      if (Array.isArray(list) && list.length > 0) {
        return list.map(col => ({
          slug: col.slug,
          label: col.label ?? col.name ?? col.slug,
        }));
      }
    }
  } catch {
    // Fall back to default CMS collections when schema list is unavailable.
  }
  return [
    { slug: "pages", label: "Pages" },
    { slug: "posts", label: "Posts" },
  ];
}

async function loadConnectionState(
  ctx: PluginContext,
): Promise<{ connection: OpenClawConnection | null; error?: string }> {
  let raw: unknown;
  try {
    raw = await ctx.settings.get("connection");
  } catch {
    return {
      connection: null,
      error:
        "Stored OpenClaw credentials could not be read (check EMDASH_ENCRYPTION_KEY or storage health). Existing encrypted settings were preserved.",
    };
  }
  if (typeof raw !== "string" || !raw) return { connection: null };
  try {
    const parsed = JSON.parse(raw) as Partial<OpenClawConnection>;
    if (
      typeof parsed.gatewayUrl === "string" &&
      (parsed.gatewayUrl.startsWith("https://") ||
        parsed.gatewayUrl.startsWith("wss://") ||
        parsed.gatewayUrl.startsWith("ws://127.0.0.1:") ||
        parsed.gatewayUrl.startsWith("ws://localhost:") ||
        parsed.gatewayUrl.startsWith("http://127.0.0.1:") ||
        parsed.gatewayUrl.startsWith("http://localhost:")) &&
      typeof parsed.agentId === "string" &&
      parsed.agentId.length > 0 &&
      typeof parsed.gatewayToken === "string" &&
      parsed.gatewayToken.length > 0
    ) {
      return {
        connection: {
          gatewayUrl: parsed.gatewayUrl,
          agentId: parsed.agentId,
          gatewayToken: parsed.gatewayToken,
          authorityMode:
            parsed.authorityMode === "propose_with_approval"
              ? "propose_with_approval"
              : "read_only",
          enabledCollections: Array.isArray(parsed.enabledCollections)
            ? parsed.enabledCollections.filter((item): item is string => typeof item === "string")
            : ["pages", "posts"],
        },
      };
    }
  } catch {
    // Preserve stored encrypted value instead of deleting on parse errors.
  }
  return {
    connection: null,
    error: "Stored OpenClaw settings could not be parsed. Re-save Gateway settings to replace them.",
  };
}

async function loadConnection(ctx: PluginContext): Promise<OpenClawConnection | null> {
  return (await loadConnectionState(ctx)).connection;
}

async function loadProposals(ctx: PluginContext): Promise<PendingProposal[]> {
  if (!ctx.kv) return [];
  const raw = await ctx.kv.get("pending_proposals");
  if (!Array.isArray(raw)) return [];
  return raw as PendingProposal[];
}

async function loadActiveTurn(ctx: PluginContext): Promise<ActiveTurn | null> {
  if (!ctx.kv) return null;
  const raw = await ctx.kv.get("active_turn");
  if (!raw || typeof raw !== "object") return null;
  return raw as ActiveTurn;
}

export function buildAgentPairingCommand(siteOrigin: string, pairingCode: string): string {
  return `curl -sS -X POST "${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair" -H "content-type: application/json" -d '{"pairingCode":"${pairingCode}","agentId":"openclaw","authorityMode":"propose_with_approval"}'`;
}

export function buildAgentPairingPrompt(siteOrigin: string, pairingCode: string): string {
  const pairEndpoint = `${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair`;
  return [
    `Pair yourself with my EmDash CMS site (${siteOrigin})`,
    `using one-time pairing code: ${pairingCode}`,
    ``,
    `1. Run this curl command (no npm package or`,
    `   secret gateway token needed):`,
    `   curl -sS -X POST \\`,
    `     "${pairEndpoint}" \\`,
    `     -H "content-type: application/json" \\`,
    `     -d '{`,
    `       "pairingCode": "${pairingCode}",`,
    `       "agentId": "openclaw",`,
    `       "authorityMode": "propose_with_approval"`,
    `     }'`,
    ``,
    `2. The JSON response returns your sessionToken`,
    `   and built-in MCP / agent endpoint at:`,
    `   ${pairEndpoint}`,
    `3. Reply once paired so I can click`,
    `   "Check pairing status" in EmDash.`,
  ].join("\n");
}

export function setupPage(
  isAdmin: boolean,
  collections: Array<{ slug: string; label: string }>,
  siteOrigin = "https://your-site.example.com",
  pairingCode = "oc_pair_ready",
  failure?: string,
  toast?: BlockResponse["toast"],
): BlockResponse {
  const blocks: Block[] = [header("OpenClaw")];

  if (failure) {
    blocks.push(banner("error", "Could not save OpenClaw connection", failure));
  }

  blocks.push({
    type: "stats",
    items: [
      {
        label: "Connection Status",
        value: "Awaiting Agent",
        description: "Paste the prompt below into your OpenClaw chat",
        trend: "neutral",
      },
      {
        label: "One-Time Pairing Code",
        value: pairingCode,
        description: `POST ${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair`,
      },
      {
        label: "Built-In Agent & MCP Route",
        value: "/_emdash/api/.../pair",
        description: "Zero npm packages or secrets required",
        trend: "up",
      },
    ],
  });

  if (!isAdmin) {
    blocks.push(
      context("Ask an Administrator of this site to connect the OpenClaw gateway on this page."),
    );
    return { blocks };
  }

  const leftColumn: Block[] = [
    {
      type: "empty",
      size: "sm",
      title: "Option 1 — 1-Click Copy Command for Your Agent",
      description:
        "Click the copy icon on the command pill (or copy the prompt block below) and paste it into OpenClaw, Codex, Claude Code, or any agent chat.",
      command_line: buildAgentPairingCommand(siteOrigin, pairingCode),
      actions: [
        {
          type: "button",
          label: "Check pairing status",
          action_id: "check_pairing",
          style: "primary",
        },
        {
          type: "button",
          label: "Rotate pairing code",
          action_id: "rotate_pairing_code",
          style: "secondary",
        },
      ],
    },
    {
      type: "code",
      language: "bash",
      code: buildAgentPairingPrompt(siteOrigin, pairingCode),
    },
  ];

  const rightColumn: Block[] = [
    header("How 1-Step Agent Pairing Works"),
    {
      type: "table",
      page_action_id: "pairing_steps_noop",
      columns: [
        { key: "step", label: "Step", format: "badge" },
        { key: "surface", label: "Where" },
        { key: "detail", label: "Action", format: "code" },
      ],
      rows: [
        {
          step: "1. Copy",
          surface: "Left panel",
          detail: "Click copy icon on command pill",
        },
        {
          step: "2. Send",
          surface: "OpenClaw / Codex / Chat",
          detail: "Agent POSTs pairingCode via curl",
        },
        {
          step: "3. Verify",
          surface: "EmDash",
          detail: "Click 'Check pairing status'",
        },
      ],
    },
    {
      type: "accordion",
      label: "Option 2 (Advanced Fallback): Enter Gateway URL & Bearer Token Manually",
      default_open: Boolean(failure),
      blocks: [
        {
          type: "form",
          block_id: "openclaw-connect-form",
          fields: [
            {
              type: "text_input",
              action_id: "gatewayUrl",
              label: "OpenClaw Gateway HTTPS URL",
              placeholder: "https://gateway.example.com",
            },
            {
              type: "text_input",
              action_id: "agentId",
              label: "Default Agent ID",
              initial_value: "blaze",
              placeholder: "blaze",
            },
            {
              type: "secret_input",
              action_id: "gatewayToken",
              label: "Gateway Bearer Token",
              placeholder: "oc_live_...",
            },
            {
              type: "select",
              action_id: "authorityMode",
              label: "Starting Authority Mode",
              initial_value: "read_only",
              options: [
                { label: "Read-only (inspect & answer only)", value: "read_only" },
                {
                  label: "Propose with WAITING_FOR_HUMAN approval cards",
                  value: "propose_with_approval",
                },
              ],
            },
            {
              type: "checkbox",
              action_id: "enabledCollections",
              label: "Enable Editor Side-Panel on Collections",
              initial_value: collections.map(col => col.slug),
              options: collections.map(col => ({
                label: `${col.label} (${col.slug})`,
                value: col.slug,
              })),
            },
          ],
          submit: { label: "Save connection manually", action_id: "save_connection" },
        },
      ],
    },
  ];

  blocks.push({
    type: "columns",
    columns: [leftColumn, rightColumn],
  });

  return { blocks, ...(toast ? { toast } : {}) };
}

function sanitizeAdminPublicUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const k of [
      "token",
      "bootstrapToken",
      "deviceToken",
      "password",
      "secret",
      "apiKey",
      "api_key",
      "access_token",
      "auth",
    ]) {
      parsed.searchParams.delete(k);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s"']+)@/gi, "$1");
  }
}

function hasEmbeddedUrlCredentials(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return /:\/\/[^/@\s]+@/.test(rawUrl);
  }
}

export function workspacePage(
  connection: OpenClawConnection,
  collections: Array<{ slug: string; label: string }>,
  proposals: PendingProposal[],
  activeTurn: ActiveTurn | null,
  isAdmin: boolean,
  replyText?: string,
  toast?: BlockResponse["toast"],
): BlockResponse {
  const safeGatewayUrl = sanitizeAdminPublicUrl(connection.gatewayUrl);
  let gatewayHost = safeGatewayUrl;
  try {
    gatewayHost = new URL(safeGatewayUrl).host;
  } catch {
    // Keep sanitized URL if parsing fails.
  }

  const blocks: Block[] = [
    header("OpenClaw"),
    {
      type: "stats",
      items: [
        {
          label: "Active OpenClaw Agent",
          value: `@${connection.agentId}`,
          description: gatewayHost,
          trend: "up",
        },
        {
          label: "Task Status",
          value: activeTurn ? activeTurn.status : "Idle",
          description: activeTurn ? activeTurn.prompt : "Ready for instructions",
        },
        {
          label: "Approval Queue",
          value: proposals.length,
          description:
            proposals.length === 0 ? "No pending mutations" : "Awaiting WAITING_FOR_HUMAN review",
          trend: proposals.length > 0 ? "up" : "neutral",
        },
      ],
    },
  ];

  const assistantLeft: Block[] = [
    {
      type: "form",
      block_id: "openclaw-prompt-form",
      fields: [
        {
          type: "text_input",
          action_id: "prompt",
          label: `Message @${connection.agentId} (press Enter or click Send)`,
          placeholder: "Can you see my product collection? Suggest headlines...",
        },
      ],
      submit: { label: "Send to OpenClaw", action_id: "ask_agent" },
    },
  ];

  const assistantRight: Block[] = [];
  if (replyText) {
    assistantRight.push(banner("default", `Response from @${connection.agentId}`, replyText));
  } else if (activeTurn && activeTurn.status === "completed") {
    assistantRight.push(
      banner("default", `Response from @${connection.agentId}`, activeTurn.lastUpdate),
    );
  }
  if (activeTurn && activeTurn.status !== "completed") {
    assistantRight.push(
      banner(
        "alert",
        `@${connection.agentId} is working (${activeTurn.status})`,
        `Task: "${activeTurn.prompt}" — ${activeTurn.lastUpdate}`,
      ),
      {
        type: "form",
        block_id: "openclaw-steer-form",
        fields: [
          {
            type: "text_input",
            action_id: "steerMessage",
            label: `Steer @${connection.agentId} mid-task`,
            placeholder: "Adjust tone, narrow scope, or change target fields...",
          },
        ],
        submit: { label: "Steer agent", action_id: "steer_agent" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            label: "Check status",
            action_id: "check_status",
            style: "primary",
          },
        ],
      },
    );
  } else if (!replyText) {
    assistantRight.push({
      type: "empty",
      size: "sm",
      title: `Connected to @${connection.agentId}`,
      description:
        "Send a task on the left or open any enabled collection entry to collaborate in the Editor Side-Panel.",
    });
  }

  const approvalBlocks: Block[] =
    proposals.length === 0
      ? [
          {
            type: "empty",
            size: "base",
            title: "No Pending Approval Cards",
            description:
              "When your OpenClaw agent proposes content edits or site actions, WAITING_FOR_HUMAN cards appear here.",
          },
        ]
      : proposals.flatMap(proposal => [
          fields(
            ["Proposal", proposal.summary],
            ["Tool / Action", proposal.targetTool],
            ["Agent", `@${proposal.agentId}`],
            ...(proposal.collection
              ? [
                  [
                    "Target Entry",
                    `${proposal.collection}/${proposal.entryId ?? ""}`,
                  ] as [string, string],
                ]
              : []),
          ),
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                label: "Approve action",
                action_id: "approve_proposal",
                value: proposal.proposalId,
                style: "primary" as const,
              },
              {
                type: "button" as const,
                label: "Reject",
                action_id: "reject_proposal",
                value: proposal.proposalId,
                style: "danger" as const,
              },
            ],
          },
          { type: "divider" as const },
        ]);

  const settingsBlocks: Block[] = isAdmin
    ? [
        {
          type: "columns",
          columns: [
            [
              {
                type: "form",
                block_id: "openclaw-collections-form",
                fields: [
                  {
                    type: "checkbox",
                    action_id: "enabledCollections",
                    label: "Enabled Editor Side-Panel Collections",
                    initial_value: connection.enabledCollections,
                    options: collections.map(col => ({
                      label: `${col.label} (${col.slug})`,
                      value: col.slug,
                    })),
                  },
                ],
                submit: { label: "Update enabled collections", action_id: "save_collections" },
              },
            ],
            [
              fields(
                ["Gateway", safeGatewayUrl],
                ["Agent ID", `@${connection.agentId}`],
                [
                  "Authority Mode",
                  connection.authorityMode === "read_only"
                    ? "Read-only"
                    : "Propose with WAITING_FOR_HUMAN cards",
                ],
              ),
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    label: "Disconnect gateway",
                    action_id: "disconnect",
                    style: "secondary",
                  },
                ],
              },
            ],
          ],
        },
      ]
    : [context("Only an Administrator can modify enabled collections or disconnect the gateway.")];

  blocks.push({
    type: "tab",
    panels: [
      {
        label: "Assistant & Live Steer",
        blocks: [{ type: "columns", columns: [assistantLeft, assistantRight] }],
      },
      {
        label: `Approval Queue (${proposals.length})`,
        blocks: approvalBlocks,
      },
      {
        label: "Collections & Connection",
        blocks: settingsBlocks,
      },
    ],
  });

  return { blocks, ...(toast ? { toast } : {}) };
}

function resolveSiteOrigin(route: SandboxedRouteContext): string {
  try {
    if (route.request?.url) {
      return new URL(route.request.url).origin;
    }
  } catch {
    // Fall back to localhost when request URL is not a full origin.
  }
  return "http://localhost:4321";
}

function csprngToken(prefix: string, byteLen = 18): string {
  const bytes = new Uint8Array(byteLen);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error("WebCrypto getRandomValues is required for token generation");
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractBearerHeader(route: SandboxedRouteContext): string | undefined {
  const headers = (route as unknown as { request?: { headers?: unknown } }).request?.headers;
  if (!headers) return undefined;
  let authVal: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    authVal = (headers as { get: (k: string) => string | null }).get("authorization");
  } else if (typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    const raw = rec.authorization ?? rec.Authorization;
    if (typeof raw === "string") authVal = raw;
  }
  if (typeof authVal === "string" && /^Bearer\s+/i.test(authVal)) {
    return authVal.replace(/^Bearer\s+/i, "").trim() || undefined;
  }
  return undefined;
}

const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

function generatePairingCode(): string {
  return csprngToken("oc_pair_", 12);
}

async function loadOrCreatePairingCode(ctx: PluginContext): Promise<string> {
  if (ctx.kv) {
    const existing = await ctx.kv.get("pairing_code");
    const expiresAt = await ctx.kv.get("pairing_code_expires_at");
    const validExpiry =
      typeof expiresAt !== "number" || expiresAt > Date.now();
    if (typeof existing === "string" && existing.startsWith("oc_pair_") && validExpiry) {
      return existing;
    }
    const fresh = generatePairingCode();
    await ctx.kv.set("pairing_code", fresh);
    await ctx.kv.set("pairing_code_expires_at", Date.now() + PAIRING_CODE_TTL_MS);
    return fresh;
  }
  return generatePairingCode();
}

async function rotatePairingCode(ctx: PluginContext): Promise<string> {
  const fresh = generatePairingCode();
  if (ctx.kv) {
    await ctx.kv.set("pairing_code", fresh);
    await ctx.kv.set("pairing_code_expires_at", Date.now() + PAIRING_CODE_TTL_MS);
  }
  return fresh;
}

export async function openclawAdmin(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<BlockResponse> {
  const role = route.user?.role ?? 0;
  if (role < EDITOR) {
    return {
      blocks: [
        header("OpenClaw"),
        banner("error", "Permission denied", "Only Editors and Administrators can use OpenClaw."),
      ],
    };
  }

  const isAdmin = role >= ADMIN;
  const collections = await discoverSiteCollections(ctx);
  const siteOrigin = resolveSiteOrigin(route);
  const pairingCode = isAdmin ? await loadOrCreatePairingCode(ctx) : "";
  const event = parseInteraction(route.input);
  if (!event) {
    return {
      blocks: [
        header("OpenClaw"),
        banner("error", "Invalid request", "The admin request payload could not be parsed."),
      ],
    };
  }

  if (event.type === "block_action" && event.action_id === "rotate_pairing_code" && isAdmin) {
    const rotated = await rotatePairingCode(ctx);
    return setupPage(true, collections, siteOrigin, rotated, undefined, {
      type: "info",
      message: "Generated a fresh one-time OpenClaw pairing code.",
    });
  }

  if (event.type === "form_submit" && event.action_id === "save_connection") {
    if (!isAdmin) {
      return setupPage(
        false,
        collections,
        siteOrigin,
        pairingCode,
        "Only an Administrator can configure OpenClaw.",
      );
    }
    const gatewayUrl = cleanText(event.values.gatewayUrl, 300);
    const agentId = cleanText(event.values.agentId, 80);
    const gatewayToken = cleanText(event.values.gatewayToken, 300);
    const authorityMode =
      event.values.authorityMode === "propose_with_approval"
        ? "propose_with_approval"
        : "read_only";

    if (!gatewayUrl || !gatewayUrl.startsWith("https://") || hasEmbeddedUrlCredentials(gatewayUrl)) {
      return setupPage(
        true,
        collections,
        siteOrigin,
        pairingCode,
        gatewayUrl && hasEmbeddedUrlCredentials(gatewayUrl)
          ? "Gateway URL must not embed username or password credentials; use the Gateway bearer token field."
          : "Enter an HTTPS OpenClaw gateway URL.",
      );
    }
    const sanitizedGatewayUrl = sanitizeAdminPublicUrl(gatewayUrl);
    if (!agentId || !/[a-z0-9]/i.test(agentId)) {
      return setupPage(
        true,
        collections,
        siteOrigin,
        pairingCode,
        "Enter a valid OpenClaw agent ID containing letters or numbers.",
      );
    }
    if (!gatewayToken) {
      return setupPage(
        true,
        collections,
        siteOrigin,
        pairingCode,
        "Enter your OpenClaw gateway bearer token.",
      );
    }

    const enabledCollections = Array.isArray(event.values.enabledCollections)
      ? event.values.enabledCollections.filter((item): item is string => typeof item === "string")
      : collections.filter(col => event.values[`col_${col.slug}`] !== false).map(col => col.slug);

    const nextConnection: OpenClawConnection = {
      gatewayUrl: sanitizedGatewayUrl,
      agentId,
      gatewayToken,
      authorityMode,
      enabledCollections,
    };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(nextConnection),
    );
    const proposals = await loadProposals(ctx);
    const activeTurn = await loadActiveTurn(ctx);
    return workspacePage(
      nextConnection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "success",
        message: `Connected to OpenClaw (@${agentId}).`,
      },
    );
  }

  const connState = await loadConnectionState(ctx);
  const connection = connState.connection;
  if (!connection) {
    if (event.type === "block_action" && event.action_id === "check_pairing") {
      return setupPage(true, collections, siteOrigin, pairingCode, connState.error, {
        type: "info",
        message: "Waiting for your OpenClaw agent to complete the pairing POST.",
      });
    }
    return setupPage(isAdmin, collections, siteOrigin, pairingCode, connState.error);
  }

  if (event.type === "block_action" && event.action_id === "disconnect" && isAdmin) {
    await ctx.settings.delete("connection");
    const freshCode = await rotatePairingCode(ctx);
    return setupPage(true, collections, siteOrigin, freshCode);
  }

  const proposals = await loadProposals(ctx);
  let activeTurn = await loadActiveTurn(ctx);

  if (event.type === "form_submit" && event.action_id === "save_collections" && isAdmin) {
    const enabledCollections = Array.isArray(event.values.enabledCollections)
      ? event.values.enabledCollections.filter((item): item is string => typeof item === "string")
      : collections.filter(col => event.values[`col_${col.slug}`] === true).map(col => col.slug);
    const updated: OpenClawConnection = { ...connection, enabledCollections };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(updated),
    );
    return workspacePage(updated, collections, proposals, activeTurn, isAdmin, undefined, {
      type: "success",
      message: "Updated enabled editor collections.",
    });
  }

  if (
    event.type === "block_action" &&
    (event.action_id === "approve_proposal" || event.action_id === "reject_proposal")
  ) {
    const proposalId = cleanText(event.value, 120);
    if (event.action_id === "reject_proposal") {
      const remaining = await withOpenClawStorageLock("proposals", async () => {
        const current = await loadProposals(ctx);
        const next = current.filter(item => item.proposalId !== proposalId);
        if (ctx.kv) {
          await ctx.kv.set("pending_proposals", next);
        }
        return next;
      });
      return workspacePage(connection, collections, remaining, activeTurn, isAdmin, undefined, {
        type: "info",
        message: `Rejected proposal ${proposalId ?? ""}. No CMS changes were applied.`,
      });
    }
    // Honest sandbox boundary: Block Kit runs without content:write or browser _rev access.
    // Never delete the pending proposal and falsely claim "Approved".
    return workspacePage(
      connection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      "Sandboxed Block Kit mode cannot execute _rev-fenced writes directly. Open the Native OpenClaw harness or Content Editor to review and save this draft.",
      {
        type: "info",
        message: `Proposal ${proposalId ?? ""} remains pending until saved with _rev verification.`,
      },
    );
  }

  if (event.type === "form_submit" && event.action_id === "steer_agent" && activeTurn) {
    const steerMessage = cleanText(event.values.steerMessage, 500);
    if (steerMessage) {
      activeTurn = {
        ...activeTurn,
        status: "steered",
        lastUpdate: `Queued mid-task steer: "${steerMessage}"`,
      };
      if (ctx.kv) {
        await ctx.kv.set("active_turn", activeTurn);
      }
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      undefined,
      {
        type: "info",
        message: `Queued mid-task steer for @${connection.agentId}.`,
      },
    );
  }

  if (event.type === "block_action" && event.action_id === "check_status") {
    if (!activeTurn) {
      return workspacePage(
        connection,
        collections,
        proposals,
        null,
        isAdmin,
        "No active task is currently running.",
      );
    }
    if (activeTurn.status === "completed") {
      if (ctx.kv) {
        await ctx.kv.delete("active_turn");
      }
      return workspacePage(
        connection,
        collections,
        proposals,
        null,
        isAdmin,
        `Completed task "${activeTurn.prompt}": ${activeTurn.lastUpdate}`,
      );
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      activeTurn,
      isAdmin,
      `Task "${activeTurn.prompt}" is still ${activeTurn.status} — ${activeTurn.lastUpdate}`,
    );
  }

  if (event.type === "form_submit" && event.action_id === "ask_agent") {
    const prompt = cleanText(event.values.prompt, 500);
    if (!prompt) {
      return workspacePage(
        connection,
        collections,
        proposals,
        activeTurn,
        isAdmin,
        "Enter a prompt for your OpenClaw agent.",
      );
    }
    const colSummary = collections.map(c => `${c.label} (${c.slug})`).join(", ");
    const turn: ActiveTurn = {
      turnId: `turn_${Date.now()}`,
      prompt,
      status: "running",
      lastUpdate: `Site collections visible to @${connection.agentId}: ${colSummary}. Waiting for agent turn completion (or press Steer / Check status).`,
    };
    if (ctx.kv) {
      await ctx.kv.set("active_turn", turn);
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      turn,
      isAdmin,
      `@${connection.agentId} connected to collections [${colSummary}] (${connection.authorityMode}) — queued: "${prompt}"`,
    );
  }

  return workspacePage(connection, collections, proposals, activeTurn, isAdmin);
}

/**
 * Saved-entry Editor Side-Panel handler (`editor/assistant`). Collaborates with
 * the user on any entry whose collection is enabled on the OpenClaw settings page.
 */
export async function openclawEditorPanel(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<BlockResponse> {
  const role = route.user?.role ?? 0;
  if (role < EDITOR) {
    return {
      blocks: [banner("error", "Permission denied", "Only Editors and Administrators can use OpenClaw.")],
    };
  }

  const connection = await loadConnection(ctx);
  if (!connection) {
    return {
      blocks: [
        banner(
          "default",
          "OpenClaw not connected",
          "Open the OpenClaw page in the sidebar to connect your gateway first.",
        ),
      ],
    };
  }

  const ui = (route as unknown as {
    ui?: { entry?: { collection?: string; id?: string; locale?: string; version?: number } };
  }).ui;
  const collection = ui?.entry?.collection ?? "pages";
  const entryId = ui?.entry?.id ?? "current";

  if (!connection.enabledCollections.includes(collection)) {
    return {
      blocks: [
        context(
          `OpenClaw collaboration is currently disabled for the "${collection}" collection. Enable it on the OpenClaw sidebar page.`,
        ),
      ],
    };
  }

  const event = parseInteraction(route.input);
  if (event?.type === "form_submit" && event.action_id === "collaborate_entry") {
    const instruction = cleanText(event.values.instruction, 500);
    if (instruction && ctx.kv) {
      await withOpenClawStorageLock("proposals", async () => {
        const proposals = await loadProposals(ctx);
        proposals.push({
          proposalId: `prop_${Date.now()}`,
          agentId: connection.agentId,
          collection,
          entryId,
          summary: `${collection}/${entryId}: ${instruction}`,
          targetTool: "content:collaborate",
          createdAt: new Date().toISOString(),
        });
        await ctx.kv!.set("pending_proposals", proposals);
      });
    }
    return {
      blocks: [
        banner(
          "default",
          `Sent to @${connection.agentId}`,
          instruction
            ? `Queued collaboration request for ${collection}/${entryId}: "${instruction}". Review proposals on the OpenClaw page.`
            : "Enter an instruction to collaborate on this entry.",
        ),
      ],
    };
  }

  return {
    blocks: [
      fields(["Agent", `@${connection.agentId}`], ["Entry", `${collection}/${entryId}`]),
      {
        type: "form",
        block_id: "openclaw-entry-form",
        fields: [
          {
            type: "text_input",
            action_id: "instruction",
            label: `Collaborate with @${connection.agentId} on this ${collection} entry`,
            placeholder: "Tighten copy, generate SEO description, or check links...",
          },
        ],
        submit: { label: "Ask OpenClaw", action_id: "collaborate_entry" },
      },
    ],
  };
}

/**
 * Public 1-step pairing & built-in MCP/Agent endpoint (`POST /_emdash/api/plugins/dinkus-openclaw/pair`).
 * - Accepts 1-step pairing with ONLY `pairingCode` (no npm package, no external gateway URL, and no 1Password secret needed).
 * - Mints a scoped `sessionToken` (`oc_sess_...`) and serves MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`)
 *   and REST actions (`poll_turn`, `complete_turn`, `propose`) at the same URL.
 */
function validateExternalProposalSubmission(
  connection: OpenClawConnection,
  collection: string | undefined,
  entryId: string | undefined,
  proposedFields: Record<string, string> | undefined,
): { code: string; message: string } | null {
  const hasConcreteFields = Boolean(proposedFields && Object.keys(proposedFields).length > 0);
  if (connection.authorityMode !== "propose_with_approval") {
    return {
      code: "AUTHORITY_READ_ONLY",
      message:
        "OpenClaw connection is in read_only authority mode; submitting content proposals is disabled.",
    };
  }
  if (collection && !connection.enabledCollections.includes(collection)) {
    return {
      code: "COLLECTION_NOT_ENABLED",
      message: `Collection "${collection}" is not enabled for this OpenClaw connection.`,
    };
  }
  if (hasConcreteFields) {
    if (!collection || !connection.enabledCollections.includes(collection)) {
      return {
        code: "COLLECTION_NOT_ENABLED",
        message:
          "Concrete field patches must specify a collection enabled on this OpenClaw connection.",
      };
    }
    if (!entryId || entryId === "current") {
      return {
        code: "INVALID_PROPOSAL_TARGET",
        message: "Concrete field patches must specify a target entryId.",
      };
    }
  }
  return null;
}

export async function openclawPairRoute(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<Record<string, unknown>> {
  const input =
    typeof route.input === "object" && route.input !== null
      ? (route.input as Record<string, unknown>)
      : {};
  const siteOrigin = resolveSiteOrigin(route);
  const endpointUrl = `${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair`;
  const collections = await discoverSiteCollections(ctx);

  // 1. Built-in MCP JSON-RPC 2.0 handler so agents never hit a 404 on MCP initialization
  if (input.jsonrpc === "2.0" && typeof input.method === "string") {
    const id = input.id ?? 1;
    if (input.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dinkus-openclaw-emdash", version: "0.1.0" },
        },
      };
    }
    if (input.method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (input.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "emdash_status",
              description: "Inspect paired EmDash site collections and active turn.",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "emdash_submit_proposal",
              description: "Queue a WAITING_FOR_HUMAN approval card in EmDash.",
              inputSchema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                  targetTool: { type: "string" },
                  collection: { type: "string" },
                  entryId: { type: "string" },
                  proposedFields: { type: "object" },
                },
                required: ["summary"],
              },
            },
          ],
        },
      };
    }
    if (input.method === "tools/call") {
      const params =
        typeof input.params === "object" && input.params !== null
          ? (input.params as Record<string, unknown>)
          : {};
      const toolName = cleanText(params.name, 80);
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      const connection = await loadConnection(ctx);
      const suppliedToken =
        extractBearerHeader(route) ??
        cleanText(params.sessionToken, 300) ??
        cleanText(args.sessionToken, 300) ??
        cleanText(input.sessionToken, 300);
      if (
        !connection ||
        !suppliedToken ||
        !constantTimeEqual(suppliedToken, connection.gatewayToken)
      ) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "UNAUTHORIZED_SESSION: Pass Authorization: Bearer <sessionToken> or sessionToken.",
          },
        };
      }
      if (toolName === "emdash_submit_proposal" && ctx.kv) {
        const targetCollection = cleanText(args.collection, 60);
        const targetEntryId = cleanText(args.entryId, 80);
        const proposedFields = extractSafeExternalFields(args.proposedFields);
        const policyError = validateExternalProposalSubmission(
          connection,
          targetCollection,
          targetEntryId,
          proposedFields,
        );
        if (policyError) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32003,
              message: `${policyError.code}: ${policyError.message}`,
            },
          };
        }
        const proposal: PendingProposal = {
          proposalId: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          agentId: connection.agentId,
          collection: targetCollection,
          entryId: targetEntryId,
          summary: cleanText(args.summary, 300) ?? "Agent proposal",
          targetTool: cleanText(args.targetTool, 80) ?? "content:update",
          ...(proposedFields ? { proposedFields } : {}),
          createdAt: new Date().toISOString(),
        };
        await withOpenClawStorageLock("proposals", async () => {
          const proposals = await loadProposals(ctx);
          proposals.push(proposal);
          await ctx.kv!.set("pending_proposals", proposals);
        });
        publishOpenClawEvent({
          type: "workspace_sync",
          conversationId: "conv_default",
          reason: "external_agent_proposal",
          timestamp: new Date().toISOString(),
          visibility: "shared",
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true, proposal }) }],
          },
        };
      }
      const activeTurn = await loadActiveTurn(ctx);
      const scopedCollections = collections.filter(c =>
        connection.enabledCollections.includes(c.slug),
      );
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                collections: scopedCollections,
                authorityMode: connection.authorityMode,
                activeTurn,
                paired: true,
              }),
            },
          ],
        },
      };
    }
  }

  // 2. Agent REST actions (poll_turn / complete_turn / propose) using minted sessionToken
  const action = cleanText(input.action, 40);
  if (action) {
    const connection = await loadConnection(ctx);
    const token =
      extractBearerHeader(route) ??
      cleanText(input.sessionToken, 300) ??
      cleanText(input.gatewayToken, 300);
    if (!connection || !token || !constantTimeEqual(token, connection.gatewayToken)) {
      return {
        ok: false,
        error: "UNAUTHORIZED_SESSION",
        message: "Pass the sessionToken returned when pairing.",
      };
    }
    if (action === "poll_turn") {
      const activeTurn = await loadActiveTurn(ctx);
      const scopedCollections = collections.filter(c =>
        connection.enabledCollections.includes(c.slug),
      );
      return {
        ok: true,
        agentId: connection.agentId,
        authorityMode: connection.authorityMode,
        activeTurn,
        collections: scopedCollections,
      };
    }
    if (action === "complete_turn") {
      const reply = cleanText(input.reply, 2000) ?? "Completed.";
      const activeTurn = await loadActiveTurn(ctx);
      if (ctx.kv) {
        await ctx.kv.set("active_turn", {
          turnId: activeTurn?.turnId ?? `turn_${Date.now()}`,
          prompt: activeTurn?.prompt ?? "",
          status: "completed",
          lastUpdate: reply,
        });
      }
      publishOpenClawEvent({
        type: "workspace_sync",
        conversationId: "conv_catalog_overview",
        reason: "external_agent_turn_completed",
        timestamp: new Date().toISOString(),
        visibility: "shared",
      });
      return { ok: true, status: "completed", reply };
    }
    if (action === "propose" && ctx.kv) {
      const targetCollection = cleanText(input.collection, 60);
      const targetEntryId = cleanText(input.entryId, 80);
      const proposedFields = extractSafeExternalFields(input.proposedFields);
      const policyError = validateExternalProposalSubmission(
        connection,
        targetCollection,
        targetEntryId,
        proposedFields,
      );
      if (policyError) {
        return {
          ok: false,
          error: policyError.code,
          message: policyError.message,
        };
      }
      const proposal: PendingProposal = {
        proposalId: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        agentId: connection.agentId,
        collection: targetCollection,
        entryId: targetEntryId,
        summary: cleanText(input.summary, 300) ?? "Proposed content update",
        targetTool: cleanText(input.targetTool, 80) ?? "content:update",
        ...(proposedFields ? { proposedFields } : {}),
        createdAt: new Date().toISOString(),
      };
      await withOpenClawStorageLock("proposals", async () => {
        const proposals = await loadProposals(ctx);
        proposals.push(proposal);
        await ctx.kv!.set("pending_proposals", proposals);
      });
      publishOpenClawEvent({
        type: "workspace_sync",
        conversationId: "conv_default",
        reason: "external_agent_proposal",
        timestamp: new Date().toISOString(),
        visibility: "shared",
      });
      return { ok: true, proposal };
    }
  }

  // 3. 1-Step Pairing via admin-minted one-time pairingCode (never mints on unauthenticated requests)
  const pairingCode = cleanText(input.pairingCode, 120);
  const storedCode = ctx.kv ? await ctx.kv.get("pairing_code") : null;
  const expiresAt = ctx.kv ? await ctx.kv.get("pairing_code_expires_at") : null;
  const isExpired = typeof expiresAt === "number" && expiresAt <= Date.now();
  if (
    !pairingCode ||
    typeof storedCode !== "string" ||
    isExpired ||
    !constantTimeEqual(pairingCode, storedCode)
  ) {
    return {
      ok: false,
      error: "INVALID_PAIRING_CODE",
      message: "The pairing code is invalid or expired. Generate a fresh code on the OpenClaw page.",
    };
  }

  const rawGatewayUrl = cleanText(input.gatewayUrl, 300);
  if (rawGatewayUrl && hasEmbeddedUrlCredentials(rawGatewayUrl)) {
    return {
      ok: false,
      error: "INVALID_GATEWAY_URL",
      message: "Gateway URL must not embed username or password credentials.",
    };
  }
  const gatewayUrl =
    rawGatewayUrl &&
    (rawGatewayUrl.startsWith("https://") ||
      rawGatewayUrl.startsWith("wss://") ||
      rawGatewayUrl.startsWith("ws://127.0.0.1:") ||
      rawGatewayUrl.startsWith("ws://localhost:"))
      ? sanitizeAdminPublicUrl(rawGatewayUrl)
      : "https://agent-session.openclaw.local";
  const explicitAgentId = cleanText(input.agentId, 80);
  if (explicitAgentId !== undefined && !/[a-z0-9]/i.test(explicitAgentId)) {
    return {
      ok: false,
      error: "INVALID_AGENT_ID",
      message: "OpenClaw agentId must contain at least one alphanumeric character.",
    };
  }
  const agentId = explicitAgentId ?? "openclaw";
  const sessionToken = cleanText(input.gatewayToken, 300) ?? csprngToken("oc_sess_", 20);
  const authorityMode =
    input.authorityMode === "read_only" ? "read_only" : "propose_with_approval";

  const nextConnection: OpenClawConnection = {
    gatewayUrl,
    agentId,
    gatewayToken: sessionToken,
    authorityMode,
    enabledCollections: collections.map(col => col.slug),
  };

  const existing = await ctx.settings.getVersioned("connection");
  await ctx.settings.compareAndSet(
    "connection",
    existing?.revision ?? null,
    JSON.stringify(nextConnection),
  );
  await rotatePairingCode(ctx);
  publishOpenClawEvent({
    type: "workspace_sync",
    conversationId: "conv_catalog_overview",
    reason: "agent_paired",
    timestamp: new Date().toISOString(),
    visibility: "shared",
  });

  return {
    ok: true,
    status: "paired",
    agentId,
    authorityMode,
    sessionToken,
    mcpEndpoint: endpointUrl,
    agentEndpoint: endpointUrl,
    collections: collections.map(col => col.slug),
  };
}

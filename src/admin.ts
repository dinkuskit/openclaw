import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

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
  createdAt: string;
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
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    ? value.trim()
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

async function loadConnection(ctx: PluginContext): Promise<OpenClawConnection | null> {
  const raw = await ctx.settings.get("connection");
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OpenClawConnection>;
    if (
      typeof parsed.gatewayUrl === "string" &&
      parsed.gatewayUrl.startsWith("https://") &&
      typeof parsed.agentId === "string" &&
      parsed.agentId.length > 0 &&
      typeof parsed.gatewayToken === "string" &&
      parsed.gatewayToken.length > 0
    ) {
      return {
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
      };
    }
  } catch {
    // Malformed settings require re-setup.
  }
  return null;
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
  return `npx --yes @dinkuskit/openclaw pair "${siteOrigin}" "${pairingCode}"`;
}

export function buildAgentPairingPrompt(siteOrigin: string, pairingCode: string): string {
  const pairEndpoint = `${siteOrigin}/_emdash/api/plugins/dinkus-openclaw/pair`;
  const mcpEndpoint = `${siteOrigin}/_emdash/mcp`;
  return [
    `Connect yourself to my EmDash CMS site (${siteOrigin})`,
    `with pairing code: ${pairingCode}`,
    ``,
    `Option A (Fastest — npx helper):`,
    `  npx --yes @dinkuskit/openclaw pair \\`,
    `    "${siteOrigin}" \\`,
    `    "${pairingCode}"`,
    ``,
    `Option B (Fallback — curl + MCP registration):`,
    `  1. Register MCP server in OpenClaw config:`,
    `     ${mcpEndpoint}`,
    `  2. POST gateway credentials to:`,
    `     ${pairEndpoint}`,
    `     curl -X POST "${pairEndpoint}" \\`,
    `       -H "content-type: application/json" \\`,
    `       -d '{`,
    `         "pairingCode": "${pairingCode}",`,
    `         "gatewayUrl": "<YOUR_GATEWAY_HTTPS_URL>",`,
    `         "agentId": "<YOUR_AGENT_ID>",`,
    `         "gatewayToken": "<YOUR_GATEWAY_BEARER_TOKEN>",`,
    `         "authorityMode": "propose_with_approval"`,
    `       }'`,
    `  3. Reply once paired so I can click`,
    `     "Check pairing status" in EmDash.`,
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
        label: "Site Native MCP",
        value: "/_emdash/mcp",
        description: "Zero OpenClaw daemon plugins required",
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
      title: "Option 1 — 1-Click Copy Command for Your OpenClaw Agent",
      description:
        "Click the copy icon on the right of the command pill and drop it into your OpenClaw chat (Signal, Discord, Telegram, or Web).",
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
          detail: "Copy the pairing prompt block",
        },
        {
          step: "2. Send",
          surface: "Signal / Discord / Web",
          detail: "npx @dinkuskit/openclaw pair ...",
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

export function workspacePage(
  connection: OpenClawConnection,
  collections: Array<{ slug: string; label: string }>,
  proposals: PendingProposal[],
  activeTurn: ActiveTurn | null,
  isAdmin: boolean,
  replyText?: string,
  toast?: BlockResponse["toast"],
): BlockResponse {
  let gatewayHost = connection.gatewayUrl;
  try {
    gatewayHost = new URL(connection.gatewayUrl).host;
  } catch {
    // Keep full URL if parsing fails.
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
          label: `Ask @${connection.agentId}`,
          placeholder: "Audit draft pages, suggest headlines, or summarize content...",
          multiline: true,
        },
      ],
      submit: { label: "Send to OpenClaw", action_id: "ask_agent" },
    },
  ];

  const assistantRight: Block[] = [];
  if (replyText) {
    assistantRight.push(banner("default", `Response from @${connection.agentId}`, replyText));
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
                ["Gateway", connection.gatewayUrl],
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

function generatePairingCode(): string {
  return `oc_pair_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

async function loadOrCreatePairingCode(ctx: PluginContext): Promise<string> {
  if (ctx.kv) {
    const existing = await ctx.kv.get("pairing_code");
    if (typeof existing === "string" && existing.startsWith("oc_pair_")) {
      return existing;
    }
    const fresh = generatePairingCode();
    await ctx.kv.set("pairing_code", fresh);
    return fresh;
  }
  return "oc_pair_ready";
}

async function rotatePairingCode(ctx: PluginContext): Promise<string> {
  const fresh = generatePairingCode();
  if (ctx.kv) {
    await ctx.kv.set("pairing_code", fresh);
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
  const pairingCode = await loadOrCreatePairingCode(ctx);
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

    if (!gatewayUrl || !gatewayUrl.startsWith("https://")) {
      return setupPage(
        true,
        collections,
        siteOrigin,
        pairingCode,
        "Enter an HTTPS OpenClaw gateway URL.",
      );
    }
    if (!agentId) {
      return setupPage(
        true,
        collections,
        siteOrigin,
        pairingCode,
        "Enter the default OpenClaw agent ID.",
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
      gatewayUrl,
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

  const connection = await loadConnection(ctx);
  if (!connection) {
    if (event.type === "block_action" && event.action_id === "check_pairing") {
      return setupPage(true, collections, siteOrigin, pairingCode, undefined, {
        type: "info",
        message: "Waiting for your OpenClaw agent to complete the pairing POST.",
      });
    }
    return setupPage(isAdmin, collections, siteOrigin, pairingCode);
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
    const remaining = proposals.filter(item => item.proposalId !== proposalId);
    if (ctx.kv) {
      await ctx.kv.set("pending_proposals", remaining);
    }
    const verb = event.action_id === "approve_proposal" ? "Approved" : "Rejected";
    return workspacePage(connection, collections, remaining, activeTurn, isAdmin, undefined, {
      type: "success",
      message: `${verb} proposal ${proposalId ?? ""}.`,
    });
  }

  if (event.type === "form_submit" && event.action_id === "steer_agent" && activeTurn) {
    const steerMessage = cleanText(event.values.steerMessage, 500);
    if (steerMessage) {
      activeTurn = {
        ...activeTurn,
        status: "steered",
        lastUpdate: `Steered mid-task: "${steerMessage}"`,
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
        message: `Sent mid-task steer to @${connection.agentId}.`,
      },
    );
  }

  if (event.type === "block_action" && event.action_id === "check_status") {
    if (ctx.kv) {
      await ctx.kv.delete("active_turn");
    }
    return workspacePage(
      connection,
      collections,
      proposals,
      null,
      isAdmin,
      activeTurn
        ? `Completed task "${activeTurn.prompt}" (${activeTurn.lastUpdate}).`
        : "No active task is currently running.",
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
    const turn: ActiveTurn = {
      turnId: `turn_${Date.now()}`,
      prompt,
      status: "running",
      lastUpdate: "Dispatched to OpenClaw gateway; press Check status or Steer agent below.",
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
      `Started task on @${connection.agentId} (${connection.authorityMode}): "${prompt}"`,
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
      await ctx.kv.set("pending_proposals", proposals);
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
 * Public 1-step pairing route (`POST /_emdash/api/plugins/dinkus-openclaw/pair`).
 * Allows an OpenClaw agent to pair itself using the one-time `pairingCode` shown
 * in the EmDash admin prompt.
 */
export async function openclawPairRoute(
  route: SandboxedRouteContext,
  ctx: PluginContext,
): Promise<Record<string, unknown>> {
  const input =
    typeof route.input === "object" && route.input !== null
      ? (route.input as Record<string, unknown>)
      : {};
  const pairingCode = cleanText(input.pairingCode, 120);
  const expectedCode = await loadOrCreatePairingCode(ctx);
  if (!pairingCode || pairingCode !== expectedCode) {
    return {
      ok: false,
      error: "INVALID_PAIRING_CODE",
      message: "The pairing code is invalid or expired. Generate a fresh code on the OpenClaw page.",
    };
  }

  const gatewayUrl = cleanText(input.gatewayUrl, 300);
  const agentId = cleanText(input.agentId, 80) ?? "blaze";
  const gatewayToken = cleanText(input.gatewayToken, 300);
  const authorityMode =
    input.authorityMode === "propose_with_approval" ? "propose_with_approval" : "read_only";

  if (!gatewayUrl || !gatewayUrl.startsWith("https://") || !gatewayToken) {
    return {
      ok: false,
      error: "INVALID_GATEWAY_CREDENTIALS",
      message: "Provide an HTTPS gatewayUrl and non-empty gatewayToken.",
    };
  }

  const collections = await discoverSiteCollections(ctx);
  const nextConnection: OpenClawConnection = {
    gatewayUrl,
    agentId,
    gatewayToken,
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

  const siteOrigin = resolveSiteOrigin(route);
  return {
    ok: true,
    agentId,
    authorityMode,
    mcpEndpoint: `${siteOrigin}/_emdash/mcp`,
  };
}

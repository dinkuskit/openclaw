import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

/** EmDash Editor role (40) and Administrator role (50). */
const EDITOR = 40;
const ADMIN = 50;

export interface OpenClawConnection {
  gatewayUrl: string;
  agentId: string;
  gatewayToken: string;
  authorityMode: "read_only" | "propose_with_approval";
}

export interface PendingProposal {
  proposalId: string;
  agentId: string;
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
type Interaction = { type: "page_load" } | Action | Submit;

function parseInteraction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
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

export function setupPage(isAdmin: boolean, failure?: string): BlockResponse {
  const blocks: Block[] = [
    header("OpenClaw"),
    banner(
      failure ? "error" : "default",
      failure ? "Could not save OpenClaw connection" : "Connect OpenClaw Gateway",
      failure ??
        "Connect your OpenClaw gateway so your custom agents can inspect content, assist in the EmDash admin, and propose actions through Block Kit approval cards. Access starts read-only.",
    ),
  ];

  if (!isAdmin) {
    blocks.push(
      context("Ask an Administrator of this site to connect the OpenClaw gateway on this page."),
    );
    return { blocks };
  }

  blocks.push({
    type: "form",
    block_id: "openclaw-connect-form",
    fields: [
      {
        type: "text_input",
        action_id: "gatewayUrl",
        label: "OpenClaw Gateway HTTPS URL",
        placeholder: "https://dinkuskit.com/api/openclaw",
      },
      {
        type: "text_input",
        action_id: "agentId",
        label: "Default Agent ID",
        initial_value: "blaze",
        placeholder: "blaze",
      },
      {
        type: "text_input",
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
    ],
    submit: { label: "Save connection", action_id: "save_connection" },
  });

  return { blocks };
}

export function workspacePage(
  connection: OpenClawConnection,
  proposals: PendingProposal[],
  isAdmin: boolean,
  replyText?: string,
  toast?: BlockResponse["toast"],
): BlockResponse {
  const blocks: Block[] = [
    header("OpenClaw"),
    fields(
      ["Gateway", connection.gatewayUrl],
      ["Active Agent", `@${connection.agentId}`],
      [
        "Authority Posture",
        connection.authorityMode === "read_only"
          ? "Read-only (no site mutations)"
          : "WAITING_FOR_HUMAN approval required before mutations",
      ],
    ),
  ];

  if (replyText) {
    blocks.push(banner("default", `Response from @${connection.agentId}`, replyText));
  }

  blocks.push({
    type: "form",
    block_id: "openclaw-prompt-form",
    fields: [
      {
        type: "text_input",
        action_id: "prompt",
        label: `Ask @${connection.agentId}`,
        placeholder: "Summarize draft posts or check store status...",
      },
    ],
    submit: { label: "Send to OpenClaw", action_id: "ask_agent" },
  });

  if (proposals.length > 0) {
    blocks.push(
      header("Pending Approval Cards (WAITING_FOR_HUMAN)"),
      banner(
        "alert",
        "Human approval required",
        "OpenClaw proposed the following site or store actions. Review each card before approving or rejecting.",
      ),
    );
    for (const proposal of proposals) {
      blocks.push(
        fields(
          ["Proposal", proposal.summary],
          ["Tool / Action", proposal.targetTool],
          ["Agent", `@${proposal.agentId}`],
        ),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              label: "Approve action",
              action_id: "approve_proposal",
              value: proposal.proposalId,
              style: "primary",
            },
            {
              type: "button",
              label: "Reject",
              action_id: "reject_proposal",
              value: proposal.proposalId,
              style: "danger",
            },
          ],
        },
      );
    }
  }

  if (isAdmin) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          label: "Disconnect gateway",
          action_id: "disconnect",
          style: "secondary",
        },
      ],
    });
  }

  return { blocks, ...(toast ? { toast } : {}) };
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
  const event = parseInteraction(route.input);
  if (!event) {
    return {
      blocks: [
        header("OpenClaw"),
        banner("error", "Invalid request", "The admin request payload could not be parsed."),
      ],
    };
  }

  if (event.type === "form_submit" && event.action_id === "save_connection") {
    if (!isAdmin) {
      return setupPage(false, "Only an Administrator can configure the OpenClaw connection.");
    }
    const gatewayUrl = cleanText(event.values.gatewayUrl, 300);
    const agentId = cleanText(event.values.agentId, 80);
    const gatewayToken = cleanText(event.values.gatewayToken, 300);
    const authorityMode =
      event.values.authorityMode === "propose_with_approval"
        ? "propose_with_approval"
        : "read_only";

    if (!gatewayUrl || !gatewayUrl.startsWith("https://")) {
      return setupPage(true, "Enter an HTTPS OpenClaw gateway URL.");
    }
    if (!agentId) {
      return setupPage(true, "Enter the default OpenClaw agent ID.");
    }
    if (!gatewayToken) {
      return setupPage(true, "Enter your OpenClaw gateway bearer token.");
    }

    const nextConnection: OpenClawConnection = {
      gatewayUrl,
      agentId,
      gatewayToken,
      authorityMode,
    };
    const existing = await ctx.settings.getVersioned("connection");
    await ctx.settings.compareAndSet(
      "connection",
      existing?.revision ?? null,
      JSON.stringify(nextConnection),
    );
    const proposals = await loadProposals(ctx);
    return workspacePage(nextConnection, proposals, isAdmin, undefined, {
      type: "success",
      message: `Connected to OpenClaw (@${agentId}).`,
    });
  }

  const connection = await loadConnection(ctx);
  if (!connection) {
    return setupPage(isAdmin);
  }

  if (event.type === "block_action" && event.action_id === "disconnect" && isAdmin) {
    await ctx.settings.delete("connection");
    return setupPage(true);
  }

  const proposals = await loadProposals(ctx);

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
    return workspacePage(connection, remaining, isAdmin, undefined, {
      type: "success",
      message: `${verb} proposal ${proposalId ?? ""}.`,
    });
  }

  if (event.type === "form_submit" && event.action_id === "ask_agent") {
    const prompt = cleanText(event.values.prompt, 500);
    if (!prompt) {
      return workspacePage(
        connection,
        proposals,
        isAdmin,
        "Enter a prompt for your OpenClaw agent.",
      );
    }
    return workspacePage(
      connection,
      proposals,
      isAdmin,
      `Queued request for @${connection.agentId} (${connection.authorityMode}): "${prompt}"`,
    );
  }

  return workspacePage(connection, proposals, isAdmin);
}

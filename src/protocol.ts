export interface StoredDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface OpenClawConnection {
  gatewayUrl: string;
  agentId: string;
  gatewayToken: string;
  bootstrapToken?: string;
  deviceToken?: string;
  deviceIdentity?: StoredDeviceIdentity;
  authorityMode: "read_only" | "propose_with_approval";
  allowGatewayExecApprovals?: boolean;
  pairedAgentPoll?: boolean;
  enabledCollections: string[];
}

export interface SiteCollectionSummary {
  slug: string;
  label: string;
  entryCount?: number;
  supports?: string[];
  supportsRevisions?: boolean;
}

export interface CatalogEntrySummary {
  id: string;
  collection: string;
  slug: string;
  title: string;
  status: string;
  locale?: string;
  _rev?: string;
  excerpt?: string;
  priceSummary?: string;
  fields: Record<string, unknown>;
}

export interface ToolCallTrace {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  durationMs: number;
  status: "running" | "ok" | "error";
  summary: string;
  payload?: unknown;
}

export interface ContentFieldDiff {
  field: string;
  label: string;
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
}

export type ProposalLifecycleStatus =
  | "pending"
  | "applying"
  | "applied"
  | "conflict"
  | "failed"
  | "outcome_unknown"
  | "rejected"
  | "superseded";

export interface RevisionProposal {
  proposalId: string;
  revisionNumber: number;
  supersedesProposalId?: string;
  supersededByProposalId?: string;
  conversationId: string;
  runId?: string;
  agentId: string;
  collection: string;
  entryId: string;
  entrySlug: string;
  entryTitle: string;
  locale?: string;
  baseRev: string;
  appliedRev?: string;
  conflictRev?: string;
  decidedByUserId?: string;
  reconciledServerSide?: boolean;
  summary: string;
  targetTool: string;
  proposedFields: Record<string, unknown>;
  diffs: ContentFieldDiff[];
  status: ProposalLifecycleStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type GatewayApprovalDecision = "allow-once" | "allow-always" | "deny";

export type GatewayApprovalStatus =
  | "pending"
  | "resolving"
  | "allowed"
  | "denied"
  | "expired"
  | "cancelled";

export interface GatewayExecApproval {
  approvalId: string;
  conversationId: string;
  sessionKey?: string;
  kind: "exec" | "plugin" | "system-agent";
  agentId: string;
  title?: string;
  command: string;
  commandPreview?: string;
  description?: string;
  warningText?: string | null;
  host?: string | null;
  nodeId?: string | null;
  urlPath?: string;
  allowedDecisions: GatewayApprovalDecision[];
  reviewerBound: boolean;
  status: GatewayApprovalStatus;
  decision?: GatewayApprovalDecision;
  resolvedByUserId?: string;
  errorMessage?: string;
  createdAt: string;
  expiresAtMs?: number;
}

export interface ChatTurnMessage {
  messageId: string;
  runId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: "queued" | "streaming" | "completed" | "steered" | "stopped" | "failed";
  startupPhase?: string;
  toolCalls?: ToolCallTrace[];
  proposalIds?: string[];
  execApprovalIds?: string[];
}

export interface BoundEntryRef {
  collection: string;
  entryId: string;
  locale?: string;
  title?: string;
  slug?: string;
}

export interface ConversationThread {
  conversationId: string;
  ownerUserId?: string;
  visibility?: "personal" | "shared";
  sessionKey?: string;
  agentSessionKeys?: Record<string, string>;
  lastTurnSessionKey?: string;
  activeRunId?: string;
  runPhase?: string;
  title: string;
  scopeGroup: string;
  boundEntry?: BoundEntryRef;
  status: "idle" | "connecting" | "running" | "steered" | "stopped" | "failed";
  createdAt: string;
  updatedAt: string;
  messages: ChatTurnMessage[];
}

export interface AutomationRule {
  automationId: string;
  name: string;
  description: string;
  schedule: string;
  collection: string;
  enabled: boolean;
  lastRunSummary?: string;
}

export interface AgentTemplateEntry {
  id: string;
  name: string;
  tagline: string;
  categories: string[];
  packageUrl: string;
  detailUrl: string;
  installCommand: string;
}

export interface AgentTemplateInstallCommands {
  templateRef: string;
  agentId: string;
  sourceKind: "catalog-slug" | "tarball-url" | "local-path";
  packageTarget: string;
  enableTemplatesCommand: string;
  validateCommand: string;
  installCommand: string;
  harnessCommand: string;
  pairCommand: string;
  fullSetupScript: string;
}

export const BLOBSTER_CATALOG_URL = "https://blobster.dev";
export const BLOBSTER_SUBMIT_URL = "https://blobster.dev/submit";
export const OPENCLAW_ENABLE_TEMPLATES_CMD =
  "openclaw config set gateway.controlUi.experimental.templates true";

export const FEATURED_AGENT_TEMPLATES: AgentTemplateEntry[] = [
  {
    id: "blobster-smith",
    name: "Blobster Smith · Anvil Forgemaster",
    tagline:
      "Forges, validates, and packages OpenClaw Agent Templates (agents-template) and stages revision-fenced EmDash CMS drafts.",
    categories: ["forging", "agents-template", "cms"],
    packageUrl: "https://blobster.dev/t/blobster-smith.tgz",
    detailUrl: "https://blobster.dev/templates/blobster-smith",
    installCommand: buildAgentTemplateInstallCommands("blobster-smith").installCommand,
  },
  {
    id: "blobster-sculptor",
    name: "Blobster Sculptor · Avatar & Identity Rig",
    tagline:
      "Crafts character identity packs, turnaround rigs, and visual storefront direction for custom OpenClaw agents.",
    categories: ["identity", "avatar-rig", "design"],
    packageUrl: "https://blobster.dev/t/blobster-sculptor.tgz",
    detailUrl: "https://blobster.dev/templates/blobster-sculptor",
    installCommand: buildAgentTemplateInstallCommands("blobster-sculptor").installCommand,
  },
];

function shellSafeArg(value: string): string {
  if (/^[A-Za-z0-9._~:/@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function deriveTemplateAgentId(rawSegment: string): string {
  const withoutArchive = rawSegment
    .replace(/\.(?:tgz|tar\.gz)$/i, "")
    .replace(/-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/, "");
  const normalized = withoutArchive
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return normalized || "openclaw";
}

export function buildAgentTemplateInstallCommands(
  templateRef: string,
  siteOrigin = "http://localhost:4321",
  pairingCode?: string,
): AgentTemplateInstallCommands {
  const cleanedRef = (typeof templateRef === "string" ? templateRef : "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, "")
    .trim();
  const effectiveRef = cleanedRef || "blobster-smith";

  let cleanOrigin = "http://localhost:4321";
  try {
    cleanOrigin = new URL(siteOrigin).origin;
  } catch {
    // Keep fallback origin when siteOrigin is malformed.
  }

  let sourceKind: AgentTemplateInstallCommands["sourceKind"];
  let packageTarget: string;
  let agentId: string;
  let validateTarget: string;

  if (/^https?:\/\//i.test(effectiveRef)) {
    sourceKind = "tarball-url";
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(effectiveRef);
      parsedUrl.username = "";
      parsedUrl.password = "";
      parsedUrl.hash = "";
    } catch {
      parsedUrl = null;
    }
    packageTarget = parsedUrl ? parsedUrl.toString() : effectiveRef;
    const lastSeg = (parsedUrl?.pathname ?? effectiveRef).split("/").filter(Boolean).pop() ?? "";
    agentId = deriveTemplateAgentId(lastSeg);
    validateTarget = `./${agentId}`;
  } else if (
    effectiveRef.startsWith("./") ||
    effectiveRef.startsWith("../") ||
    effectiveRef.startsWith("/") ||
    effectiveRef.startsWith("~/") ||
    effectiveRef.includes("/") ||
    effectiveRef.includes("\\") ||
    /\.(?:tgz|tar\.gz)$/i.test(effectiveRef)
  ) {
    sourceKind = "local-path";
    packageTarget = effectiveRef;
    const segments = effectiveRef.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
    agentId = deriveTemplateAgentId(segments[segments.length - 1] ?? "custom-agent");
    validateTarget = effectiveRef;
  } else {
    sourceKind = "catalog-slug";
    agentId = deriveTemplateAgentId(effectiveRef);
    packageTarget = `${BLOBSTER_CATALOG_URL}/t/${agentId}.tgz`;
    validateTarget = `./${agentId}`;
  }

  const enableTemplatesCommand = OPENCLAW_ENABLE_TEMPLATES_CMD;
  const isArchive = sourceKind !== "local-path" || /\.(?:tgz|tar\.gz)$/i.test(packageTarget);
  const addSource = isArchive ? '"$openclaw_template_dir"' : shellSafeArg(packageTarget);
  const addCommand = `openclaw templates add ${addSource} --agent-id ${agentId}`;
  // The CLI accepts extracted package directories, not archives. Keep each
  // extraction in a fresh directory and support npm-style and flat archives.
  const prepareArchive = [
    'openclaw_template_dir="$(mktemp -d)"',
    sourceKind === "local-path"
      ? `cp -- ${shellSafeArg(packageTarget)} "$openclaw_template_dir/template.tgz"`
      : `curl --fail --show-error --location ${shellSafeArg(packageTarget)} -o "$openclaw_template_dir/template.tgz"`,
    'mkdir "$openclaw_template_dir/source"',
    'tar -xzf "$openclaw_template_dir/template.tgz" -C "$openclaw_template_dir/source"',
    'openclaw_template_dir="$openclaw_template_dir/source"',
    'if [ -f "$openclaw_template_dir/package/package.json" ]; then openclaw_template_dir="$openclaw_template_dir/package"; fi',
    'openclaw templates validate "$openclaw_template_dir"',
  ].join(" &&\n");
  const validateCommand = isArchive
    ? prepareArchive
    : `openclaw templates validate ${shellSafeArg(validateTarget)}`;
  const installCommand = isArchive ? `${prepareArchive} &&\n${addCommand}` : addCommand;
  const harnessCommand = "openclaw gateway run";
  const cleanPairingCode =
    typeof pairingCode === "string" && /^oc_pair_[a-z0-9_]+$/i.test(pairingCode.trim())
      ? pairingCode.trim()
      : "<PAIRING_CODE>";
  const pairCommand = `curl -sS -X POST "${cleanOrigin}/_emdash/api/plugins/dinkus-openclaw/pair" -H "content-type: application/json" -d '{"pairingCode":"${cleanPairingCode}","agentId":"${agentId}","authorityMode":"propose_with_approval"}'`;

  const fullSetupScript = [
    `# 1. Enable Agent Templates on a fresh OpenClaw gateway\n${enableTemplatesCommand}`,
    ...(!isArchive ? [`# 2. Validate local agents-template bundle\n${validateCommand}`] : []),
    `# 3. Install Agent Template into your OpenClaw harness\n${installCommand}`,
    `# 4. Start the Gateway in a separate terminal before pairing agent ${agentId}:\n# ${harnessCommand}`,
    `# 5. Pair @${agentId} with @dinkuskit/openclaw (${cleanOrigin})\n${pairCommand}`,
  ].join("\n\n");

  return {
    templateRef: effectiveRef,
    agentId,
    sourceKind,
    packageTarget,
    enableTemplatesCommand,
    validateCommand,
    installCommand,
    harnessCommand,
    pairCommand,
    fullSetupScript,
  };
}

export interface GatewayBridgeStatus {
  available: boolean;
  state:
    | "disconnected"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "auth_error"
    | "pairing_pending";
  gatewayUrl?: string;
  gatewayControlUiOrigin?: string;
  protocolVersion?: number;
  serverVersion?: string;
  grantedScopes: string[];
  deviceId?: string;
  lastError?: string;
}

export interface OpenClawWorkspaceSnapshot {
  ok: true;
  currentUserId: string;
  isAdmin: boolean;
  userRole: number;
  canResolveGatewayApprovals: boolean;
  siteOrigin: string;
  siteName: string;
  paired: boolean;
  settingsError?: string;
  pairingCode: string;
  pairingCommand: string;
  pairingPrompt: string;
  connection: {
    gatewayUrl: string;
    agentId: string;
    authorityMode: "read_only" | "propose_with_approval";
    allowGatewayExecApprovals: boolean;
    enabledCollections: string[];
    transportMode: "gateway-ws" | "live-gateway" | "paired-agent";
  } | null;
  gatewayBridge: GatewayBridgeStatus;
  collections: SiteCollectionSummary[];
  entriesPreview: CatalogEntrySummary[];
  threads: ConversationThread[];
  activeConversationId: string;
  proposals: RevisionProposal[];
  execApprovals: GatewayExecApproval[];
  automations: AutomationRule[];
  agentTemplates: AgentTemplateEntry[];
  catalogUrl: string;
  submitUrl: string;
  playgroundMode?: boolean;
  playgroundLocked?: boolean;
  streamEndpoint: string;
}

export interface StreamEventAudience {
  ownerUserId?: string;
  visibility?: "personal" | "shared";
}

export type OpenClawStreamEvent =
  | ({
      type: "connected";
      timestamp: string;
      conversationId?: string;
    } & StreamEventAudience)
  | ({
      type: "turn_started";
      conversationId: string;
      messageId: string;
      runId?: string;
      prompt: string;
      timestamp: string;
    } & StreamEventAudience)
  | ({
      type: "run_status";
      conversationId: string;
      messageId?: string;
      runId: string;
      phase: string;
      timestamp: string;
    } & StreamEventAudience)
  | ({
      type: "tool_call";
      conversationId: string;
      messageId: string;
      toolCall: ToolCallTrace;
      timestamp: string;
    } & StreamEventAudience)
  | ({
      type: "assistant_delta";
      conversationId: string;
      messageId: string;
      delta: string;
      content: string;
      replace?: boolean;
      timestamp: string;
    } & StreamEventAudience)
  | ({
      type: "proposal_updated";
      proposal: RevisionProposal;
      timestamp: string;
    } & StreamEventAudience)
  | ({
      type: "exec_approval_updated";
      approval: GatewayExecApproval;
      timestamp: string;
    } & StreamEventAudience)
  | {
      type: "gateway_status";
      gatewayBridge: GatewayBridgeStatus;
      timestamp: string;
    }
  | ({
      type: "workspace_sync";
      conversationId: string;
      reason: string;
      timestamp: string;
    } & StreamEventAudience);

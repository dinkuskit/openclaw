export interface StoredDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface OpenClawConnection {
  gatewayUrl: string;
  agentId: string;
  gatewayToken: string;
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

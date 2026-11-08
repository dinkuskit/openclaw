import type {
  GatewayApprovalDecision,
  GatewayBridgeStatus,
  GatewayExecApproval,
  OpenClawConnection,
  StoredDeviceIdentity,
  ToolCallTrace,
} from "./protocol.js";

export interface GatewayTurnRequest {
  connection: OpenClawConnection;
  conversationId: string;
  ownerUserId?: string;
  visibility?: "personal" | "shared";
  messageId: string;
  sessionKey: string;
  prompt: string;
  systemContext?: string;
  steer?: boolean;
  expectedRunId?: string;
  timeoutMs?: number;
  resolveLatestAudience?: () => Promise<{
    ownerUserId?: string;
    visibility: "personal" | "shared";
  }>;
  onDeviceCredentialsUpdated?: (patch: {
    deviceIdentity?: StoredDeviceIdentity;
    deviceToken?: string;
  }) => Promise<void>;
}

export interface GatewayTurnResult {
  ok: boolean;
  runId?: string;
  replyText: string;
  status: "completed" | "stopped" | "failed";
  toolCalls: ToolCallTrace[];
  approvals: GatewayExecApproval[];
  errorMessage?: string;
}

export interface GatewayHistoryResult {
  ok: boolean;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    createdAt?: string;
  }>;
}

export interface HostGatewayBridge {
  ensureDeviceIdentity(existing?: StoredDeviceIdentity): StoredDeviceIdentity;
  normalizeGatewayInput(
    rawUrl: string,
    rawToken?: string,
  ): {
    ok: boolean;
    wsUrl?: string;
    controlUiOrigin?: string;
    extractedToken?: string;
    isWebSocketGateway: boolean;
    error?: string;
  };
  getStatus(connection: OpenClawConnection | null): GatewayBridgeStatus;
  connect(
    connection: OpenClawConnection,
    onDeviceCredentialsUpdated?: (patch: {
      deviceIdentity?: StoredDeviceIdentity;
      deviceToken?: string;
    }) => Promise<void>,
  ): Promise<GatewayBridgeStatus>;
  disconnect(): Promise<void>;
  updateSessionAudience(
    sessionKey: string,
    audience: { ownerUserId?: string; visibility: "personal" | "shared" },
  ): void;
  sendTurn(req: GatewayTurnRequest): Promise<GatewayTurnResult>;
  abortTurn(params: {
    connection: OpenClawConnection;
    sessionKey: string;
    runId?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  fetchHistory(params: {
    connection: OpenClawConnection;
    sessionKey: string;
    limit?: number;
  }): Promise<GatewayHistoryResult>;
  listLiveApprovals(conversationId?: string): GatewayExecApproval[];
  resolveApproval(params: {
    connection: OpenClawConnection;
    approvalId: string;
    kind: "exec" | "plugin" | "system-agent";
    decision: GatewayApprovalDecision;
    resolvedByUserId: string;
  }): Promise<{ ok: boolean; approval?: GatewayExecApproval; error?: string }>;
}

const BRIDGE_SYMBOL = Symbol.for("dinkuskit.openclaw.gatewayBridge");

export function registerHostGatewayBridge(bridge: HostGatewayBridge): void {
  const g = globalThis as Record<symbol, HostGatewayBridge | undefined>;
  g[BRIDGE_SYMBOL] = bridge;
}

export function getHostGatewayBridge(): HostGatewayBridge | null {
  const g = globalThis as Record<symbol, HostGatewayBridge | undefined>;
  return g[BRIDGE_SYMBOL] ?? null;
}

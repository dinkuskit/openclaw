import crypto from "node:crypto";
import {
  GatewayClient,
  getGatewaySessionMessageSubscriptionCoordinator,
  resetGatewaySessionMessageSubscriptionCoordinator,
} from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol/frame-guards";
import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import {
  getHostGatewayBridge,
  registerHostGatewayBridge,
  type GatewayHistoryResult,
  type GatewayTurnRequest,
  type GatewayTurnResult,
  type HostGatewayBridge,
} from "./gateway-bridge-registry.js";
import type {
  GatewayApprovalDecision,
  GatewayBridgeStatus,
  GatewayExecApproval,
  OpenClawConnection,
  StoredDeviceIdentity,
  ToolCallTrace,
} from "./protocol.js";
import { publishOpenClawEvent } from "./sse-bus.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function pemEncode(label: "PUBLIC KEY" | "PRIVATE KEY", der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function generateGatewayDeviceIdentity(): StoredDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
  const deviceId = crypto.createHash("sha256").update(rawPub).digest("hex");
  return {
    deviceId,
    publicKeyPem: pemEncode("PUBLIC KEY", spki),
    privateKeyPem: pemEncode("PRIVATE KEY", pkcs8),
  };
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url");
}

export function signEd25519DevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

export function redactGatewaySecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s"']+)@/gi, "$1[REDACTED]@")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /([?&#](?:token|bootstrapToken|deviceToken|password|secret|apiKey|api_key|access_token|auth)=)[^&#\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/\boc_(?:live|sess|tok|pair)_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]");
}

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

export function sanitizePublicEndpointUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const u = new URL(rawUrl);
    u.username = "";
    u.password = "";
    u.hash = "";
    for (const k of SENSITIVE_QUERY_KEYS) {
      u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return redactGatewaySecrets(rawUrl);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}

export function normalizeGatewayEndpoint(
  rawUrl: string,
  rawToken?: string,
): {
  ok: boolean;
  wsUrl?: string;
  httpUrl?: string;
  controlUiOrigin?: string;
  extractedToken?: string;
  isWebSocketGateway: boolean;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === "https://agent-session.openclaw.local") {
    return {
      ok: true,
      wsUrl: undefined,
      httpUrl: trimmed || undefined,
      controlUiOrigin: undefined,
      extractedToken: rawToken?.trim() || undefined,
      isWebSocketGateway: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      isWebSocketGateway: false,
      error: "Invalid Gateway URL. Use ws://127.0.0.1:18789 for loopback or wss:// for remote Gateways.",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      isWebSocketGateway: false,
      error:
        "Gateway URL must not embed username or password credentials. Enter secrets in the Gateway token field.",
    };
  }

  // Extract one-time pairing fragment or query token if operator pasted `openclaw dashboard` browserUrl,
  // stripping it immediately so credentials never stay in stored URLs.
  let extractedToken = rawToken?.trim() || undefined;
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const hashToken = hashParams.get("token") ?? hashParams.get("bootstrapToken");
  const queryToken = parsed.searchParams.get("token") ?? parsed.searchParams.get("bootstrapToken");
  const hasControlUiHandoffToken = Boolean(hashToken || queryToken);
  if (!extractedToken && (hashToken || queryToken)) {
    extractedToken = (hashToken ?? queryToken ?? "").trim() || undefined;
  }
  parsed.hash = "";
  for (const k of SENSITIVE_QUERY_KEYS) {
    parsed.searchParams.delete(k);
  }

  const loopback = isLoopbackHostname(parsed.hostname);
  const isControlUiBrowserUrl =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.pathname === "/chat" ||
      parsed.pathname.startsWith("/chat/") ||
      hasControlUiHandoffToken);

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (parsed.protocol === "http:" && !loopback) {
      return {
        ok: false,
        isWebSocketGateway: false,
        error:
          "Plaintext http:// is restricted to loopback (127.0.0.1 / localhost). Use https:// or wss:// for remote endpoints.",
      };
    }
    if (!isControlUiBrowserUrl) {
      return {
        ok: true,
        wsUrl: undefined,
        httpUrl: parsed.toString().replace(/\/$/, ""),
        controlUiOrigin: undefined,
        extractedToken,
        isWebSocketGateway: false,
      };
    }
  }

  let wsProtocol: "ws:" | "wss:";
  let httpProtocol: "http:" | "https:";

  if (parsed.protocol === "ws:" || parsed.protocol === "http:") {
    if (!loopback) {
      return {
        ok: false,
        isWebSocketGateway: false,
        error: "Plaintext ws:// / http:// is restricted to loopback (127.0.0.1 / localhost). Use wss:// for remote Gateways.",
      };
    }
    wsProtocol = "ws:";
    httpProtocol = "http:";
  } else if (parsed.protocol === "wss:" || parsed.protocol === "https:") {
    wsProtocol = "wss:";
    httpProtocol = "https:";
  } else {
    return {
      ok: false,
      isWebSocketGateway: false,
      error: `Unsupported Gateway URL scheme "${parsed.protocol}". Use ws:// (loopback), wss://, or https://.`,
    };
  }

  const wsUrlObj = new URL(parsed.toString());
  wsUrlObj.protocol = wsProtocol;
  wsUrlObj.username = "";
  wsUrlObj.password = "";
  // Strip Control UI `/chat/...` path if operator pasted a Control UI browser URL
  if (wsUrlObj.pathname === "/chat" || wsUrlObj.pathname.startsWith("/chat/")) {
    wsUrlObj.pathname = "/";
  }

  const controlUiOrigin = `${httpProtocol}//${parsed.host}`;
  return {
    ok: true,
    wsUrl: wsUrlObj.toString().replace(/\/$/, ""),
    controlUiOrigin,
    extractedToken,
    isWebSocketGateway: true,
  };
}

function extractTextFromGatewayMessage(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const rec = msg as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string") return rec.content;
  if (Array.isArray(rec.content)) {
    return rec.content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

interface ActiveRunCollector {
  conversationId: string;
  ownerUserId?: string;
  visibility?: "personal" | "shared";
  messageId: string;
  sessionKey: string;
  runId?: string;
  timeoutMs: number;
  accumulatedText: string;
  toolCalls: ToolCallTrace[];
  approvals: GatewayExecApproval[];
  resolve: (res: GatewayTurnResult) => void;
  settled: boolean;
  timer: NodeJS.Timeout;
}

class NodeOpenClawGatewayBridge implements HostGatewayBridge {
  #client: GatewayClient | null = null;
  #fingerprint = "";
  #status: GatewayBridgeStatus = {
    available: true,
    state: "disconnected",
    grantedScopes: [],
  };
  #readyPromise: Promise<GatewayBridgeStatus> | null = null;
  #sessionToConversation = new Map<
    string,
    { conversationId: string; ownerUserId?: string; visibility?: "personal" | "shared" }
  >();
  #audienceSeq = new Map<string, number>();
  #steerRunIds = new Set<string>();
  #activeCollectors = new Map<string, ActiveRunCollector>();
  #approvals = new Map<string, GatewayExecApproval>();

  ensureDeviceIdentity(existing?: StoredDeviceIdentity): StoredDeviceIdentity {
    if (
      existing &&
      typeof existing.deviceId === "string" &&
      existing.deviceId.length >= 32 &&
      existing.publicKeyPem.includes("BEGIN PUBLIC KEY") &&
      existing.privateKeyPem.includes("BEGIN PRIVATE KEY")
    ) {
      return existing;
    }
    return generateGatewayDeviceIdentity();
  }

  normalizeGatewayInput(rawUrl: string, rawToken?: string) {
    return normalizeGatewayEndpoint(rawUrl, rawToken);
  }

  getStatus(connection: OpenClawConnection | null): GatewayBridgeStatus {
    if (!connection) {
      return {
        available: true,
        state: "disconnected",
        grantedScopes: [],
      };
    }
    const normalized = normalizeGatewayEndpoint(connection.gatewayUrl, connection.gatewayToken);
    if (!normalized.isWebSocketGateway) {
      return {
        available: true,
        state: "disconnected",
        grantedScopes: [],
      };
    }
    return {
      ...this.#status,
      gatewayUrl: sanitizePublicEndpointUrl(normalized.wsUrl ?? this.#status.gatewayUrl),
      gatewayControlUiOrigin: sanitizePublicEndpointUrl(
        normalized.controlUiOrigin ?? this.#status.gatewayControlUiOrigin,
      ),
      deviceId: connection.deviceIdentity?.deviceId ?? this.#status.deviceId,
    };
  }

  async connect(
    connection: OpenClawConnection,
    onDeviceCredentialsUpdated?: (patch: {
      deviceIdentity?: StoredDeviceIdentity;
      deviceToken?: string;
    }) => Promise<void>,
  ): Promise<GatewayBridgeStatus> {
    const normalized = normalizeGatewayEndpoint(connection.gatewayUrl, connection.gatewayToken);
    if (!normalized.ok || !normalized.isWebSocketGateway || !normalized.wsUrl) {
      this.#status = {
        available: true,
        state: normalized.ok ? "disconnected" : "auth_error",
        grantedScopes: [],
        lastError: normalized.error,
      };
      return this.#status;
    }

    const identity = this.ensureDeviceIdentity(connection.deviceIdentity);
    if (!connection.deviceIdentity && onDeviceCredentialsUpdated) {
      await onDeviceCredentialsUpdated({ deviceIdentity: identity }).catch(() => {});
    }

    const tokenCandidate =
      normalized.extractedToken && !normalized.extractedToken.startsWith("oc_sess_")
        ? normalized.extractedToken
        : undefined;

    const computeFingerprint = (devToken?: string) =>
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            wsUrl: normalized.wsUrl,
            agentId: connection.agentId,
            token: tokenCandidate ?? "",
            deviceToken: devToken ?? "",
            deviceId: identity.deviceId,
          }),
        )
        .digest("hex");

    const nextFingerprint = computeFingerprint(connection.deviceToken);

    if (
      this.#client &&
      this.#fingerprint === nextFingerprint &&
      (this.#status.state === "connected" || this.#status.state === "connecting")
    ) {
      if (this.#readyPromise && this.#status.state === "connecting") {
        return await this.#readyPromise;
      }
      return this.#status;
    }

    const hadPriorSessions =
      this.#sessionToConversation.size > 0 || this.#activeCollectors.size > 0;
    await this.disconnect();
    this.#fingerprint = nextFingerprint;
    this.#status = {
      available: true,
      state: "connecting",
      gatewayUrl: normalized.wsUrl,
      gatewayControlUiOrigin: normalized.controlUiOrigin,
      grantedScopes: [],
      deviceId: identity.deviceId,
    };
    this.#emitStatus();

    let storedDeviceToken = connection.deviceToken;
    let helloCount = 0;

    const connectSettled = new Promise<GatewayBridgeStatus>(resolve => {
      let resolvedOnce = false;
      const finishOnce = (st: GatewayBridgeStatus) => {
        if (!resolvedOnce) {
          resolvedOnce = true;
          resolve(st);
        }
      };

      const client = new GatewayClient({
        url: normalized.wsUrl,
        token: tokenCandidate,
        deviceToken: storedDeviceToken,
        deviceIdentity: identity,
        clientName: "gateway-client",
        clientDisplayName: "EmDash OpenClaw Bridge",
        clientVersion: "0.1.0",
        mode: "backend",
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        connectChallengeTimeoutMs: 6_000,
        requestTimeoutMs: 25_000,
        hostDeps: {
          loadOrCreateDeviceIdentity: () => identity,
          signDevicePayload: signEd25519DevicePayload,
          publicKeyRawBase64UrlFromPem,
          loadDeviceAuthToken: () =>
            storedDeviceToken
              ? {
                  token: storedDeviceToken,
                  scopes: ["operator.read", "operator.write", "operator.approvals"],
                }
              : null,
          storeDeviceAuthToken: ({ token, scopes }) => {
            storedDeviceToken = token;
            if (this.#client === client) {
              this.#fingerprint = computeFingerprint(token);
            }
            if (Array.isArray(scopes) && scopes.length > 0) {
              this.#status = { ...this.#status, grantedScopes: scopes };
            }
            void onDeviceCredentialsUpdated?.({ deviceToken: token }).catch(() => {});
          },
          clearDeviceAuthToken: () => {
            storedDeviceToken = undefined;
            if (this.#client === client) {
              this.#fingerprint = computeFingerprint(undefined);
            }
          },
          redactForLog: redactGatewaySecrets,
        },
        onHelloOk: (hello: HelloOk) => {
          helloCount += 1;
          const helloRec = hello as unknown as {
            protocol?: number;
            server?: { version?: string };
            auth?: { scopes?: string[]; deviceToken?: string };
          };
          const scopes = Array.isArray(helloRec.auth?.scopes)
            ? helloRec.auth.scopes
            : ["operator.read", "operator.write"];
          this.#status = {
            available: true,
            state: "connected",
            gatewayUrl: normalized.wsUrl,
            gatewayControlUiOrigin: normalized.controlUiOrigin,
            protocolVersion: helloRec.protocol ?? PROTOCOL_VERSION,
            serverVersion: helloRec.server?.version,
            grantedScopes: scopes,
            deviceId: identity.deviceId,
            lastError: undefined,
          };
          this.#emitStatus();
          if (helloCount > 1 || hadPriorSessions) {
            queueMicrotask(() => {
              if (this.#client === client) {
                void this.#recoverSessionsAfterReconnect(connection.agentId);
              }
            });
          }
          finishOnce(this.#status);
        },
        onConnectError: (err: Error) => {
          const safeMsg = redactGatewaySecrets(err.message || String(err));
          const lower = safeMsg.toLowerCase();
          const isPairing =
            lower.includes("pair") ||
            lower.includes("not_paired") ||
            lower.includes("device") && lower.includes("approve");
          this.#status = {
            ...this.#status,
            state: isPairing ? "pairing_pending" : "auth_error",
            lastError: safeMsg,
          };
          this.#emitStatus();
          finishOnce(this.#status);
        },
        onClose: (_code, reason) => {
          if (this.#client !== client) return;
          resetGatewaySessionMessageSubscriptionCoordinator(client);
          const safeReason = reason ? redactGatewaySecrets(reason) : undefined;
          if (this.#status.state === "connected") {
            this.#status = {
              ...this.#status,
              state: "reconnecting",
              lastError: safeReason,
            };
            this.#emitStatus();
          } else {
            finishOnce({
              ...this.#status,
              state: this.#status.state === "connecting" ? "auth_error" : this.#status.state,
              lastError: this.#status.lastError ?? safeReason ?? "Gateway socket closed before hello-ok",
            });
          }
        },
        onEvent: (evt: EventFrame) => {
          this.#handleGatewayEvent(evt);
        },
      });

      this.#client = client;
      client.start();

      setTimeout(() => {
        if (!resolvedOnce) {
          finishOnce({
            ...this.#status,
            state: this.#status.state === "connecting" ? "auth_error" : this.#status.state,
            lastError: this.#status.lastError ?? "Timed out connecting to OpenClaw Gateway.",
          });
        }
      }, 6_500).unref?.();
    });

    this.#readyPromise = connectSettled;
    return await connectSettled;
  }

  async disconnect(): Promise<void> {
    const current = this.#client;
    this.#client = null;
    this.#readyPromise = null;
    this.#fingerprint = "";
    if (current) {
      resetGatewaySessionMessageSubscriptionCoordinator(current);
      current.stop();
    }
    this.#status = {
      available: true,
      state: "disconnected",
      grantedScopes: [],
    };
    this.#emitStatus();
  }

  updateSessionAudience(
    sessionKey: string,
    audience: { ownerUserId?: string; visibility: "personal" | "shared" },
  ): void {
    this.#audienceSeq.set(sessionKey, (this.#audienceSeq.get(sessionKey) ?? 0) + 1);
    const binding = this.#sessionToConversation.get(sessionKey);
    this.#sessionToConversation.set(sessionKey, {
      conversationId: binding?.conversationId ?? "",
      ownerUserId: audience.ownerUserId ?? binding?.ownerUserId,
      visibility: audience.visibility,
    });
    const collector = this.#activeCollectors.get(sessionKey);
    if (collector) {
      collector.ownerUserId = audience.ownerUserId ?? collector.ownerUserId;
      collector.visibility = audience.visibility;
    }
  }

  async #recoverSessionsAfterReconnect(agentId: string): Promise<void> {
    const sessionKeys = new Set<string>([
      ...this.#sessionToConversation.keys(),
      ...this.#activeCollectors.keys(),
    ]);
    for (const sessionKey of sessionKeys) {
      await this.#ensureSubscribed(sessionKey, agentId);
      const collector = this.#activeCollectors.get(sessionKey);
      if (collector && !collector.settled) {
        this.#refreshCollectorTimer(collector);
      }
      const binding = this.#sessionToConversation.get(sessionKey);
      const conversationId = collector?.conversationId ?? binding?.conversationId;
      if (conversationId) {
        publishOpenClawEvent({
          type: "workspace_sync",
          conversationId,
          reason: "gateway_reconnected",
          timestamp: new Date().toISOString(),
          ownerUserId: collector?.ownerUserId ?? binding?.ownerUserId,
          visibility: collector?.visibility ?? binding?.visibility ?? "personal",
        });
      }
    }
  }

  #createCollectorTimer(collector: ActiveRunCollector): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (collector.settled) return;
      const now = Date.now();
      const awaitingHumanApproval = Array.from(this.#approvals.values()).some(
        a =>
          a.sessionKey === collector.sessionKey &&
          (a.status === "pending" || a.status === "resolving") &&
          (!a.expiresAtMs || a.expiresAtMs > now),
      );
      if (awaitingHumanApproval) {
        collector.timer = this.#createCollectorTimer(collector);
        return;
      }
      collector.settled = true;
      this.#activeCollectors.delete(collector.sessionKey);
      collector.resolve({
        ok: false,
        runId: collector.runId,
        replyText: collector.accumulatedText,
        status: "failed",
        toolCalls: collector.toolCalls,
        approvals: collector.approvals,
        errorMessage: collector.accumulatedText
          ? "Gateway turn timed out before reaching a terminal event."
          : "Gateway run timed out waiting for terminal event.",
      });
    }, collector.timeoutMs);
    timer.unref?.();
    return timer;
  }

  #refreshCollectorTimer(collector: ActiveRunCollector): void {
    if (collector.settled) return;
    clearTimeout(collector.timer);
    collector.timer = this.#createCollectorTimer(collector);
  }

  async #ensureSubscribed(sessionKey: string, agentId: string): Promise<void> {
    if (!this.#client || this.#status.state !== "connected") return;
    const coordinator = getGatewaySessionMessageSubscriptionCoordinator(this.#client);
    const includeApprovals = this.#status.grantedScopes.includes("operator.approvals");
    try {
      const sub = await coordinator.acquire(sessionKey, {
        agentId,
        includeApprovals,
      });
      if (sub.approvalReplay && typeof sub.approvalReplay === "object") {
        const replay = sub.approvalReplay as { approvals?: unknown[] };
        if (Array.isArray(replay.approvals)) {
          for (const raw of replay.approvals) {
            this.#ingestApprovalRecord(sessionKey, raw);
          }
        }
      }
    } catch {
      // Older or restricted Gateways may omit sessions.messages.subscribe; global chat events still arrive.
    }
  }

  async fetchHistory(params: {
    connection: OpenClawConnection;
    sessionKey: string;
    limit?: number;
  }): Promise<GatewayHistoryResult> {
    const status = await this.connect(params.connection);
    if (status.state !== "connected" || !this.#client) {
      return { ok: false, messages: [] };
    }
    try {
      const res = await this.#client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: params.sessionKey,
        agentId: params.connection.agentId,
        limit: params.limit ?? 40,
      });
      const rawList = Array.isArray(res?.messages) ? res.messages : [];
      const messages = rawList
        .map(item => {
          if (!item || typeof item !== "object") return null;
          const r = item as Record<string, unknown>;
          const role = r.role === "user" ? ("user" as const) : r.role === "assistant" ? ("assistant" as const) : null;
          const content = extractTextFromGatewayMessage(r);
          if (!role || !content.trim()) return null;
          return {
            role,
            content,
            createdAt: typeof r.timestamp === "string" ? r.timestamp : undefined,
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return { ok: true, messages };
    } catch {
      return { ok: false, messages: [] };
    }
  }

  #resolveEffectiveTurnAudience(
    req: GatewayTurnRequest,
    seqAtStart: number,
    refreshed?: { ownerUserId?: string; visibility: "personal" | "shared" },
  ): { ownerUserId?: string; visibility: "personal" | "shared" } {
    const seqNow = this.#audienceSeq.get(req.sessionKey) ?? 0;
    const bound = this.#sessionToConversation.get(req.sessionKey);
    if (seqNow > seqAtStart && bound?.visibility) {
      const visibility =
        bound.visibility === "personal" || refreshed?.visibility === "personal"
          ? "personal"
          : (refreshed?.visibility ?? bound.visibility);
      return {
        ownerUserId: bound.ownerUserId ?? refreshed?.ownerUserId ?? req.ownerUserId,
        visibility,
      };
    }
    return {
      ownerUserId: refreshed?.ownerUserId ?? req.ownerUserId,
      visibility: refreshed?.visibility ?? req.visibility ?? "personal",
    };
  }

  async sendTurn(req: GatewayTurnRequest): Promise<GatewayTurnResult> {
    const seqAtStart = this.#audienceSeq.get(req.sessionKey) ?? 0;
    const priorBinding = this.#sessionToConversation.get(req.sessionKey);
    if (!priorBinding) {
      this.#sessionToConversation.set(req.sessionKey, {
        conversationId: req.conversationId,
        ownerUserId: req.ownerUserId,
        visibility: req.visibility ?? "personal",
      });
    } else if (!priorBinding.conversationId) {
      this.#sessionToConversation.set(req.sessionKey, {
        ...priorBinding,
        conversationId: req.conversationId,
      });
    }

    const status = await this.connect(req.connection, req.onDeviceCredentialsUpdated);
    if (status.state !== "connected" || !this.#client) {
      return {
        ok: false,
        replyText: "",
        status: "failed",
        toolCalls: [],
        approvals: [],
        errorMessage: status.lastError ?? `Gateway is ${status.state}.`,
      };
    }

    await this.#ensureSubscribed(req.sessionKey, req.connection.agentId);
    const refreshedAudience = await req.resolveLatestAudience?.().catch(() => undefined);
    const effectiveAudience = this.#resolveEffectiveTurnAudience(req, seqAtStart, refreshedAudience);
    this.#sessionToConversation.set(req.sessionKey, {
      conversationId: req.conversationId,
      ownerUserId: effectiveAudience.ownerUserId,
      visibility: effectiveAudience.visibility,
    });

    const composedMessage = req.systemContext
      ? `${req.prompt}\n\n<emdash_store_context>\n${req.systemContext}\n</emdash_store_context>`
      : req.prompt;

    if (req.steer) {
      const activeCollector = this.#activeCollectors.get(req.sessionKey);
      const originatingRunId = req.expectedRunId ?? activeCollector?.runId;
      try {
        // Published 2026.11.1 ChatSendParamsSchema has additionalProperties: false and does NOT accept expectedRunId.
        const ack = await this.#client.request<{ runId?: string }>("chat.send", {
          sessionKey: req.sessionKey,
          agentId: req.connection.agentId,
          message: req.prompt,
          queueMode: "steer",
          idempotencyKey: `emdash_steer_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
        });
        if (
          ack &&
          typeof ack.runId === "string" &&
          ack.runId !== activeCollector?.runId &&
          ack.runId !== originatingRunId
        ) {
          this.#steerRunIds.add(ack.runId);
        }
        return {
          ok: true,
          runId: originatingRunId ?? ack?.runId,
          replyText: "",
          status: "completed",
          toolCalls: [],
          approvals: [],
        };
      } catch (err) {
        return {
          ok: false,
          replyText: "",
          status: "failed",
          toolCalls: [],
          approvals: [],
          errorMessage: redactGatewaySecrets(err instanceof Error ? err.message : String(err)),
        };
      }
    }

    const timeoutMs = req.timeoutMs ?? 60_000;

    return await new Promise<GatewayTurnResult>(resolve => {
      const latestAudience = this.#resolveEffectiveTurnAudience(req, seqAtStart, refreshedAudience);
      const collector: ActiveRunCollector = {
        conversationId: req.conversationId,
        ownerUserId: latestAudience.ownerUserId,
        visibility: latestAudience.visibility,
        messageId: req.messageId,
        sessionKey: req.sessionKey,
        timeoutMs,
        accumulatedText: "",
        toolCalls: [],
        approvals: [],
        settled: false,
        resolve,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      collector.timer = this.#createCollectorTimer(collector);
      this.#activeCollectors.set(req.sessionKey, collector);

      this.#client!
        .request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: req.sessionKey,
          agentId: req.connection.agentId,
          message: composedMessage,
          idempotencyKey: `emdash_turn_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
        })
        .then(ack => {
          if (ack && typeof ack.runId === "string" && !collector.runId) {
            collector.runId = ack.runId;
          }
        })
        .catch(err => {
          if (collector.settled) return;
          collector.settled = true;
          clearTimeout(collector.timer);
          this.#activeCollectors.delete(req.sessionKey);
          resolve({
            ok: false,
            replyText: "",
            status: "failed",
            toolCalls: collector.toolCalls,
            approvals: collector.approvals,
            errorMessage: redactGatewaySecrets(err instanceof Error ? err.message : String(err)),
          });
        });
    });
  }

  async abortTurn(params: {
    connection: OpenClawConnection;
    sessionKey: string;
    runId?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!this.#client || this.#status.state !== "connected") {
      return { ok: false, error: "Gateway not connected" };
    }
    const targetRunId = params.runId ?? this.#activeCollectors.get(params.sessionKey)?.runId;
    try {
      // Published 2026.11.1 ChatAbortParamsSchema accepts { sessionKey, agentId?, runId?, preserveSideRuns? } (never sessionId).
      const res = await this.#client.request<{ ok?: boolean; aborted?: boolean; runIds?: string[] }>(
        "chat.abort",
        {
          sessionKey: params.sessionKey,
          agentId: params.connection.agentId,
          ...(targetRunId ? { runId: targetRunId } : {}),
        },
      );
      if (res && typeof res === "object" && (res.ok === false || res.aborted === false)) {
        return {
          ok: false,
          error: "Gateway reported that no active run was aborted.",
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: redactGatewaySecrets(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  listLiveApprovals(conversationId?: string): GatewayExecApproval[] {
    const now = Date.now();
    const list: GatewayExecApproval[] = [];
    for (const [id, item] of this.#approvals) {
      const nextItem =
        item.status === "pending" && item.expiresAtMs && item.expiresAtMs <= now
          ? { ...item, status: "expired" as const }
          : item;
      if (nextItem !== item) {
        this.#approvals.set(id, nextItem);
      }
      if (!conversationId || nextItem.conversationId === conversationId) {
        list.push(nextItem);
      }
    }
    return list;
  }

  async resolveApproval(params: {
    connection: OpenClawConnection;
    approvalId: string;
    kind: "exec" | "plugin" | "system-agent";
    decision: GatewayApprovalDecision;
    resolvedByUserId: string;
  }): Promise<{ ok: boolean; approval?: GatewayExecApproval; error?: string }> {
    const status = await this.connect(params.connection);
    if (status.state !== "connected" || !this.#client) {
      return { ok: false, error: status.lastError ?? "Gateway is disconnected." };
    }
    if (!status.grantedScopes.includes("operator.approvals")) {
      return {
        ok: false,
        error: "Gateway connection does not hold operator.approvals scope. Resolve in OpenClaw Control UI.",
      };
    }

    const existing = this.#approvals.get(params.approvalId);
    const existingBinding = existing?.sessionKey
      ? this.#sessionToConversation.get(existing.sessionKey)
      : undefined;
    const approvalAudience = {
      ownerUserId: existingBinding?.ownerUserId ?? params.resolvedByUserId,
      visibility: existingBinding?.visibility ?? ("personal" as const),
    };
    if (existing) {
      if (existing.status !== "pending") {
        return { ok: false, error: `Approval is already ${existing.status}.`, approval: existing };
      }
      if (existing.expiresAtMs && existing.expiresAtMs <= Date.now()) {
        const expired = { ...existing, status: "expired" as const };
        this.#approvals.set(params.approvalId, expired);
        return { ok: false, error: "Approval has expired.", approval: expired };
      }
      if (!existing.allowedDecisions.includes(params.decision)) {
        return {
          ok: false,
          error: `Decision "${params.decision}" is not permitted for this approval.`,
          approval: existing,
        };
      }
      const resolving: GatewayExecApproval = { ...existing, status: "resolving" };
      this.#approvals.set(params.approvalId, resolving);
      publishOpenClawEvent({
        type: "exec_approval_updated",
        approval: resolving,
        timestamp: new Date().toISOString(),
        ...approvalAudience,
      });
    }

    let rpcResult: unknown;
    try {
      rpcResult = await this.#client.request("approval.resolve", {
        id: params.approvalId,
        kind: params.kind,
        decision: params.decision,
      });
    } catch {
      // Fallback for Gateways using legacy surface-specific approval resolve method
      try {
        const fallbackMethod =
          params.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
        rpcResult = await this.#client.request(fallbackMethod, {
          id: params.approvalId,
          decision: params.decision,
        });
      } catch (err) {
        const safeErr = redactGatewaySecrets(err instanceof Error ? err.message : String(err));
        const latestInMap = this.#approvals.get(params.approvalId);
        if (latestInMap && latestInMap.status !== "resolving" && latestInMap.status !== "pending") {
          return { ok: false, approval: latestInMap, error: safeErr };
        }
        if (existing) {
          const reverted: GatewayExecApproval = {
            ...existing,
            status: "pending",
            errorMessage: safeErr,
          };
          this.#approvals.set(params.approvalId, reverted);
          publishOpenClawEvent({
            type: "exec_approval_updated",
            approval: reverted,
            timestamp: new Date().toISOString(),
            ...approvalAudience,
          });
        }
        return {
          ok: false,
          error: safeErr,
        };
      }
    }

    const resObj =
      rpcResult && typeof rpcResult === "object"
        ? (rpcResult as Record<string, unknown>)
        : {};
    const applied = typeof resObj.applied === "boolean" ? resObj.applied : undefined;
    const parsedFromRpc =
      resObj.approval && typeof resObj.approval === "object"
        ? this.#parseApprovalRecord(existing?.sessionKey ?? "", resObj.approval, existing)
        : typeof resObj.status === "string"
          ? this.#parseApprovalRecord(existing?.sessionKey ?? "", resObj, existing)
          : null;
    const latestFromWs = this.#approvals.get(params.approvalId);

    const baseRecord: GatewayExecApproval = existing ?? {
      approvalId: params.approvalId,
      conversationId: "conv_catalog_overview",
      kind: params.kind,
      agentId: params.connection.agentId,
      command: params.approvalId,
      allowedDecisions: ["allow-once", "deny"],
      reviewerBound: true,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    let resolved: GatewayExecApproval;
    if (parsedFromRpc) {
      resolved = {
        ...baseRecord,
        ...parsedFromRpc,
        resolvedByUserId:
          applied === false ? latestFromWs?.resolvedByUserId : params.resolvedByUserId,
        errorMessage: undefined,
      };
    } else if (
      latestFromWs &&
      latestFromWs.status !== "resolving" &&
      latestFromWs.status !== "pending"
    ) {
      resolved = latestFromWs;
    } else {
      const recordedDecision =
        resObj.decision === "allow-once" ||
        resObj.decision === "allow-always" ||
        resObj.decision === "deny"
          ? resObj.decision
          : params.decision;
      resolved = {
        ...baseRecord,
        status: recordedDecision === "deny" ? "denied" : "allowed",
        decision: recordedDecision,
        resolvedByUserId: params.resolvedByUserId,
        errorMessage: undefined,
      };
    }

    this.#approvals.set(params.approvalId, resolved);
    publishOpenClawEvent({
      type: "exec_approval_updated",
      approval: resolved,
      timestamp: new Date().toISOString(),
      ...approvalAudience,
    });

    if (
      applied === false ||
      resolved.status === "expired" ||
      resolved.status === "cancelled" ||
      (resolved.decision && resolved.decision !== params.decision)
    ) {
      return {
        ok: false,
        approval: resolved,
        error: `Gateway did not apply "${params.decision}" — approval is ${resolved.status}${resolved.decision ? ` (${resolved.decision})` : ""}.`,
      };
    }

    return { ok: true, approval: resolved };
  }

  #emitStatus(): void {
    publishOpenClawEvent({
      type: "gateway_status",
      gatewayBridge: this.#status,
      timestamp: new Date().toISOString(),
    });
  }

  #handleGatewayEvent(evt: EventFrame): void {
    const payload =
      evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};

    if (evt.event === "chat") {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
      const state = typeof payload.state === "string" ? payload.state : "";
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;

      if (runId && this.#steerRunIds.has(runId)) {
        if (state === "final" || state === "aborted" || state === "error") {
          this.#steerRunIds.delete(runId);
        }
        return;
      }

      const collector = this.#activeCollectors.get(sessionKey);
      if (collector) {
        if (runId && collector.runId && runId !== collector.runId) {
          return;
        }
        if (runId && !collector.runId) {
          collector.runId = runId;
        }
        if (state === "status" || state === "delta") {
          this.#refreshCollectorTimer(collector);
        }
      }

      const binding = this.#sessionToConversation.get(sessionKey);
      const conversationId = collector?.conversationId ?? binding?.conversationId;
      const audience = {
        ownerUserId: collector?.ownerUserId ?? binding?.ownerUserId,
        visibility: collector?.visibility ?? binding?.visibility ?? ("personal" as const),
      };

      if (state === "status" && conversationId && runId && typeof payload.phase === "string") {
        publishOpenClawEvent({
          type: "run_status",
          conversationId,
          messageId: collector?.messageId,
          runId,
          phase: payload.phase,
          timestamp: new Date().toISOString(),
          ...audience,
        });
        return;
      }

      if (state === "delta") {
        const deltaText = typeof payload.deltaText === "string" ? payload.deltaText : "";
        const replace = payload.replace === true;
        if (collector) {
          collector.accumulatedText = replace ? deltaText : collector.accumulatedText + deltaText;
          publishOpenClawEvent({
            type: "assistant_delta",
            conversationId: collector.conversationId,
            messageId: collector.messageId,
            delta: deltaText,
            content: collector.accumulatedText,
            replace,
            timestamp: new Date().toISOString(),
            ...audience,
          });
        }
        return;
      }

      if (state === "final" || state === "aborted" || state === "error") {
        if (!collector || collector.settled) return;
        collector.settled = true;
        clearTimeout(collector.timer);
        this.#activeCollectors.delete(sessionKey);

        const finalMsgText = extractTextFromGatewayMessage(payload.message);
        const replyText = finalMsgText || collector.accumulatedText;
        if (finalMsgText && finalMsgText !== collector.accumulatedText) {
          publishOpenClawEvent({
            type: "assistant_delta",
            conversationId: collector.conversationId,
            messageId: collector.messageId,
            delta: finalMsgText,
            content: finalMsgText,
            replace: true,
            timestamp: new Date().toISOString(),
            ...audience,
          });
        }

        collector.resolve({
          ok: state === "final",
          runId: collector.runId,
          replyText,
          status: state === "final" ? "completed" : state === "aborted" ? "stopped" : "failed",
          toolCalls: collector.toolCalls,
          approvals: collector.approvals,
          errorMessage:
            typeof payload.errorMessage === "string"
              ? redactGatewaySecrets(payload.errorMessage)
              : undefined,
        });
        return;
      }
    }

    if (evt.event === "agent") {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
      const runId = typeof payload.runId === "string" ? payload.runId : undefined;
      if (runId && this.#steerRunIds.has(runId)) return;
      const collector = this.#activeCollectors.get(sessionKey);
      if (!collector) return;
      if (runId && collector.runId && runId !== collector.runId) return;
      if (runId && !collector.runId) collector.runId = runId;
      this.#refreshCollectorTimer(collector);
      const stream = typeof payload.stream === "string" ? payload.stream : "";
      const data =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : {};
      if (stream === "tool" || typeof data.toolName === "string" || typeof data.name === "string") {
        const toolName = String(data.toolName ?? data.name ?? "gateway.tool");
        const callId = String(data.toolCallId ?? data.callId ?? `gw_tool_${collector.toolCalls.length + 1}`);
        const phase = String(data.phase ?? "end");
        const existingIdx = collector.toolCalls.findIndex(t => t.callId === callId);
        const trace: ToolCallTrace = {
          callId,
          name: toolName,
          args:
            data.args && typeof data.args === "object"
              ? (data.args as Record<string, unknown>)
              : {},
          durationMs: typeof data.durationMs === "number" ? data.durationMs : 1,
          status: phase === "error" ? "error" : phase === "start" ? "running" : "ok",
          summary:
            typeof data.summary === "string"
              ? data.summary
              : phase === "start"
                ? "running on OpenClaw Gateway"
                : "completed on OpenClaw Gateway",
          payload: data.result ?? data.output,
        };
        if (existingIdx >= 0) {
          collector.toolCalls[existingIdx] = trace;
        } else {
          collector.toolCalls.push(trace);
        }
        publishOpenClawEvent({
          type: "tool_call",
          conversationId: collector.conversationId,
          messageId: collector.messageId,
          toolCall: trace,
          timestamp: new Date().toISOString(),
          ownerUserId: collector.ownerUserId,
          visibility: collector.visibility ?? "personal",
        });
      }
      return;
    }

    if (
      evt.event === "session.approval" ||
      evt.event === "exec.approval.requested" ||
      evt.event === "exec.approval.resolved"
    ) {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
      const rawRecord =
        payload.approval && typeof payload.approval === "object" ? payload.approval : payload;
      this.#ingestApprovalRecord(sessionKey, rawRecord);
    }
  }

  #parseApprovalRecord(
    sessionKey: string,
    raw: unknown,
    existing?: GatewayExecApproval,
  ): GatewayExecApproval | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const approvalId =
      typeof rec.id === "string"
        ? rec.id
        : typeof rec.approvalId === "string"
          ? rec.approvalId
          : existing?.approvalId;
    if (!approvalId) return null;

    const hasPresentation = Boolean(rec.presentation && typeof rec.presentation === "object");
    const pres = hasPresentation ? (rec.presentation as Record<string, unknown>) : rec;
    const kind =
      pres.kind === "plugin"
        ? ("plugin" as const)
        : pres.kind === "system-agent"
          ? ("system-agent" as const)
          : (existing?.kind ?? ("exec" as const));
    const rawAllowed = Array.isArray(pres.allowedDecisions)
      ? pres.allowedDecisions
      : (existing?.allowedDecisions ?? []);
    const allowedDecisions = rawAllowed.filter(
      (d): d is GatewayApprovalDecision =>
        d === "allow-once" || d === "allow-always" || d === "deny",
    );
    if (!allowedDecisions.includes("deny")) {
      allowedDecisions.push("deny");
    }
    if (allowedDecisions.length === 1 && allowedDecisions[0] === "deny") {
      allowedDecisions.unshift("allow-once");
    }

    const effSessionKey = sessionKey || existing?.sessionKey || "";
    const binding = effSessionKey ? this.#sessionToConversation.get(effSessionKey) : undefined;
    const collector = effSessionKey ? this.#activeCollectors.get(effSessionKey) : undefined;
    const conversationId =
      collector?.conversationId ||
      binding?.conversationId ||
      existing?.conversationId ||
      "conv_catalog_overview";

    const rawStatus = typeof rec.status === "string" ? rec.status : (existing?.status ?? "pending");
    const status =
      rawStatus === "allowed" ||
      rawStatus === "denied" ||
      rawStatus === "expired" ||
      rawStatus === "cancelled"
        ? rawStatus
        : "pending";

    return {
      approvalId,
      conversationId,
      sessionKey: effSessionKey || undefined,
      kind,
      agentId:
        typeof pres.agentId === "string" ? pres.agentId : (existing?.agentId ?? "openclaw"),
      title: typeof pres.title === "string" ? pres.title : existing?.title,
      command:
        typeof pres.commandText === "string"
          ? pres.commandText
          : typeof pres.title === "string"
            ? pres.title
            : (existing?.command ?? approvalId),
      commandPreview:
        typeof pres.commandPreview === "string" ? pres.commandPreview : existing?.commandPreview,
      description:
        typeof pres.description === "string" ? pres.description : existing?.description,
      warningText:
        typeof pres.warningText === "string"
          ? pres.warningText
          : (existing?.warningText ?? null),
      host: typeof pres.host === "string" ? pres.host : (existing?.host ?? null),
      nodeId: typeof pres.nodeId === "string" ? pres.nodeId : (existing?.nodeId ?? null),
      urlPath: typeof rec.urlPath === "string" ? rec.urlPath : existing?.urlPath,
      allowedDecisions,
      reviewerBound: this.#status.grantedScopes.includes("operator.approvals"),
      status,
      decision:
        rec.decision === "allow-once" || rec.decision === "allow-always" || rec.decision === "deny"
          ? rec.decision
          : existing?.decision,
      createdAt:
        typeof rec.createdAtMs === "number"
          ? new Date(rec.createdAtMs).toISOString()
          : (existing?.createdAt ?? new Date().toISOString()),
      expiresAtMs:
        typeof rec.expiresAtMs === "number" ? rec.expiresAtMs : existing?.expiresAtMs,
    };
  }

  #ingestApprovalRecord(sessionKey: string, raw: unknown): void {
    const recId =
      raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : undefined;
    const existing = recId ? this.#approvals.get(recId) : undefined;
    const approval = this.#parseApprovalRecord(sessionKey, raw, existing);
    if (!approval) return;

    const effSessionKey = approval.sessionKey ?? sessionKey;
    const binding = effSessionKey ? this.#sessionToConversation.get(effSessionKey) : undefined;
    const collector = effSessionKey ? this.#activeCollectors.get(effSessionKey) : undefined;

    this.#approvals.set(approval.approvalId, approval);
    if (collector) {
      this.#refreshCollectorTimer(collector);
      const idx = collector.approvals.findIndex(a => a.approvalId === approval.approvalId);
      if (idx >= 0) {
        collector.approvals[idx] = approval;
      } else {
        collector.approvals.push(approval);
      }
    }
    const ownerUserId = collector?.ownerUserId ?? binding?.ownerUserId;
    publishOpenClawEvent({
      type: "exec_approval_updated",
      approval,
      timestamp: new Date().toISOString(),
      ownerUserId,
      visibility:
        collector || binding
          ? (collector?.visibility ?? binding?.visibility ?? "personal")
          : undefined,
    });
  }
}

export function installNodeGatewayBridge(): HostGatewayBridge {
  const existing = getHostGatewayBridge();
  if (existing) return existing;
  const bridge = new NodeOpenClawGatewayBridge();
  registerHostGatewayBridge(bridge);
  return bridge;
}

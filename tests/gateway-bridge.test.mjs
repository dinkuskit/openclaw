import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createPlugin } from "../dist/native.mjs";

function startMockOpenClawGateway({ grantApprovalsScope = true } = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const receivedFrames = [];
  let approvalResolvedPayload = null;
  let chatAbortPayload = null;
  let steerSendPayload = null;

  wss.on("connection", ws => {
    // 1. Gateway v4 immediately sends connect.challenge
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce_test_v4_12345", ts: Date.now() },
      }),
    );

    ws.on("message", raw => {
      const frame = JSON.parse(String(raw));
      receivedFrames.push(frame);
      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        assert.equal(frame.params.minProtocol, 4);
        assert.equal(frame.params.maxProtocol, 4);
        assert.ok(frame.params.device?.id, "Ed25519 device identity must be sent");
        assert.ok(frame.params.device?.signature, "Ed25519 challenge signature must be sent");

        const scopes = grantApprovalsScope
          ? ["operator.read", "operator.write", "operator.approvals"]
          : ["operator.read", "operator.write"];

        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "2026.11.1-mock", connId: "conn_mock_1" },
              features: {
                methods: [
                  "chat.send",
                  "chat.abort",
                  "chat.history",
                  "sessions.messages.subscribe",
                  "approval.resolve",
                ],
                events: ["chat", "agent", "session.approval"],
              },
              auth: {
                deviceToken: "oc_dev_tok_issued_by_gateway",
                role: "operator",
                scopes,
              },
              policy: {
                maxPayload: 1048576,
                maxBufferedBytes: 4194304,
                tickIntervalMs: 30000,
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.messages.subscribe") {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { subscribed: true, sessionKey: frame.params.sessionKey },
          }),
        );
        return;
      }

      if (frame.method === "chat.send") {
        if (frame.params.queueMode === "steer") {
          steerSendPayload = frame.params;
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: frame.params.expectedRunId ?? "run_steered_1", status: "started" },
            }),
          );
          return;
        }

        const runId = "run_gw_v4_001";
        const sessionKey = frame.params.sessionKey;
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "started" },
          }),
        );

        // Stream startup phase -> tool call -> exec approval -> delta -> structured emdash-proposal -> final!
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                seq: 1,
                state: "status",
                phase: "preparing_context",
              },
            }),
          );

          ws.send(
            JSON.stringify({
              type: "event",
              event: "agent",
              payload: {
                runId,
                sessionKey,
                stream: "tool",
                data: {
                  toolCallId: "gw_call_1",
                  toolName: "catalog.audit",
                  phase: "end",
                  durationMs: 14,
                  summary: "Audited live product copy via Gateway",
                  result: { checked: 1 },
                },
              },
            }),
          );

          ws.send(
            JSON.stringify({
              type: "event",
              event: "session.approval",
              payload: {
                sessionKey,
                phase: "requested",
                approval: {
                  id: "appr_exec_99",
                  status: "pending",
                  urlPath: "/chat/main?approval=appr_exec_99",
                  createdAtMs: Date.now(),
                  expiresAtMs: Date.now() + 120_000,
                  presentation: {
                    kind: "exec",
                    agentId: "roboclaw",
                    title: "Run storefront link checker",
                    commandText: "openclaw check-links --origin http://localhost:4321",
                    commandPreview: "openclaw check-links --origin http://localhost:4321",
                    host: "gateway-node-1",
                    allowedDecisions: ["allow-once", "deny"],
                  },
                },
              },
            }),
          );

          const replyWithProposal = [
            "I audited **Atelier Field Jacket** on OpenClaw Gateway v4 and staged a draft update:",
            "",
            "```emdash-proposal",
            JSON.stringify({
              collection: "products",
              entryId: "prod_01",
              summary: "Sharpen Atelier Field Jacket excerpt from Gateway agent",
              proposedFields: {
                excerpt: "Gateway-verified waxed organic cotton field jacket.",
                seoTitle: "IGNORED_SEO_FIELD",
              },
            }),
            "```",
          ].join("\n");

          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                seq: 2,
                state: "delta",
                deltaText: replyWithProposal,
              },
            }),
          );

          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                seq: 3,
                state: "final",
                message: { role: "assistant", content: replyWithProposal },
              },
            }),
          );
        }, 15);
        return;
      }

      if (frame.method === "approval.resolve") {
        approvalResolvedPayload = frame.params;
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true, id: frame.params.id, decision: frame.params.decision },
          }),
        );
        return;
      }

      if (frame.method === "chat.abort") {
        chatAbortPayload = frame.params;
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true, aborted: true, runIds: [] },
          }),
        );
      }
    });
  });

  return new Promise(resolve => {
    wss.on("listening", () => {
      const addr = wss.address();
      resolve({
        port: addr.port,
        receivedFrames,
        getApprovalResolved: () => approvalResolvedPayload,
        getChatAbort: () => chatAbortPayload,
        getSteerSend: () => steerSendPayload,
        close: () =>
          new Promise(done => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

function makeCtx({ role = 50, userId = "u_admin", input = {}, sharedSettings, sharedKv, headers = {} }) {
  let rev = 1;
  return {
    input,
    user: { id: userId, email: `${userId}@example.test`, name: userId, role },
    ui: { surface: "admin-page", locale: "en", direction: "ltr" },
    request: {
      url: "http://localhost:4321/_emdash/api/plugins/dinkus-openclaw/chat",
      headers,
    },
    site: { url: "http://localhost:4321", name: "Atelier Store", locale: "en" },
    schema: {
      listCollections: async () => [{ slug: "products", label: "Products" }],
    },
    content: {
      list: async () => ({
        items: [
          {
            id: "prod_01",
            slug: "atelier-field-jacket",
            status: "published",
            version: 1,
            data: { title: "Atelier Field Jacket", excerpt: "Old excerpt" },
          },
        ],
      }),
      get: async () => ({
        id: "prod_01",
        slug: "atelier-field-jacket",
        status: "published",
        version: 1,
        data: { title: "Atelier Field Jacket", excerpt: "Old excerpt" },
      }),
    },
    settings: {
      get: async k => sharedSettings.get(k)?.value ?? null,
      delete: async k => sharedSettings.delete(k),
      getVersioned: async k => sharedSettings.get(k) ?? null,
      compareAndSet: async (k, expectedRev, value) => {
        if ((sharedSettings.get(k)?.revision ?? null) !== expectedRev) return { applied: false };
        sharedSettings.set(k, { value, revision: String(++rev) });
        return { applied: true };
      },
    },
    kv: {
      get: async k => (sharedKv.has(k) ? sharedKv.get(k) : null),
      set: async (k, v) => sharedKv.set(k, v),
      delete: async k => sharedKv.delete(k),
    },
    http: { fetch: async () => Response.json({ ok: true }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("Gateway v4 WebSocket bridge streams turns, parses emdash-proposal, enforces dual approval authority, and hardens /pair MCP", async () => {
  const gw = await startMockOpenClawGateway({ grantApprovalsScope: true });
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const pair = resolved.routes.pair.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();

  try {
    // 1. Configure connection using a Control UI dashboard URL with `#token=...` fragment:
    //    Verify `#token=` is stripped from stored URL and saved into encrypted settings!
    const configured = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "configure_connection",
          gatewayUrl: `http://127.0.0.1:${gw.port}/chat/main#token=oc_live_secret_bootstrap_999`,
          agentId: "roboclaw",
          authorityMode: "propose_with_approval",
          allowGatewayExecApprovals: false,
        },
      }),
    );
    assert.equal(configured.gatewayBridge.state, "connected");
    assert.equal(configured.gatewayBridge.protocolVersion, 4);
    assert.equal(configured.connection.gatewayUrl, `ws://127.0.0.1:${gw.port}`);
    assert.equal("gatewayToken" in configured.connection, false, "Browser snapshot must never expose gatewayToken");

    const rawStoredConn = JSON.parse(sharedSettings.get("connection").value);
    assert.equal(rawStoredConn.gatewayToken, "oc_live_secret_bootstrap_999");
    assert.equal(rawStoredConn.deviceToken, "oc_dev_tok_issued_by_gateway");
    assert.ok(rawStoredConn.deviceIdentity?.deviceId);

    // 2. Reject plaintext ws:// to non-loopback remote hosts!
    const badRemote = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "configure_connection",
          gatewayUrl: "ws://gateway.evil.example:18789",
        },
      }),
    );
    assert.equal(badRemote.ok, false);
    assert.equal(badRemote.error, "INVALID_GATEWAY_URL");

    // 3. Send a live chat turn over OpenClaw Gateway Protocol v4 WebSocket
    const turnSnap = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "send_message",
          conversationId: configured.activeConversationId,
          prompt: "Audit Atelier Field Jacket and check links",
        },
      }),
    );
    assert.equal(turnSnap.ok, true);
    const activeThread = turnSnap.threads.find(t => t.conversationId === turnSnap.activeConversationId);
    const assistantMsg = activeThread.messages.at(-1);
    assert.match(assistantMsg.content, /Gateway v4/);
    assert.doesNotMatch(assistantMsg.content, /```emdash-proposal/, "Raw fence must be stripped from prose");
    assert.ok(assistantMsg.toolCalls.some(t => t.name === "catalog.audit"));

    // Structured proposal parsed with SEO field stripped!
    assert.equal(turnSnap.proposals.length, 1);
    assert.equal(
      turnSnap.proposals[0].proposedFields.excerpt,
      "Gateway-verified waxed organic cotton field jacket.",
    );
    assert.equal("seoTitle" in turnSnap.proposals[0].proposedFields, false);

    // Live Gateway execution approval ingested!
    assert.equal(turnSnap.execApprovals.length, 1);
    assert.equal(turnSnap.execApprovals[0].approvalId, "appr_exec_99");
    assert.equal(turnSnap.canResolveGatewayApprovals, false, "Disabled by default until Admin opts in");

    // 4. Dual-Authority Enforcement:
    //    (a) Editor (role 40) is strictly forbidden from resolving Gateway execution approvals
    const editorAttempt = await chat(
      makeCtx({
        role: 40,
        userId: "u_editor",
        sharedSettings,
        sharedKv,
        input: {
          action: "resolve_gateway_approval",
          approvalId: "appr_exec_99",
          kind: "exec",
          decision: "allow-once",
        },
      }),
    );
    assert.equal(editorAttempt.ok, false);
    assert.equal(editorAttempt.error, "GATEWAY_APPROVAL_FORBIDDEN");

    //    (b) Site Admin (role 50) is ALSO refused while `allowGatewayExecApprovals` opt-in is false
    const adminDisabledAttempt = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "resolve_gateway_approval",
          approvalId: "appr_exec_99",
          kind: "exec",
          decision: "allow-once",
        },
      }),
    );
    assert.equal(adminDisabledAttempt.ok, false);
    assert.equal(adminDisabledAttempt.error, "GATEWAY_APPROVAL_DISABLED");

    //    (c) Site Admin enables `allowGatewayExecApprovals: true` -> resolves `allow-once` over Gateway v4!
    const enabledSnap = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "configure_connection",
          allowGatewayExecApprovals: true,
        },
      }),
    );
    assert.equal(enabledSnap.canResolveGatewayApprovals, true);

    const resolvedSnap = await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "resolve_gateway_approval",
          approvalId: "appr_exec_99",
          kind: "exec",
          decision: "allow-once",
        },
      }),
    );
    assert.equal(resolvedSnap.ok, true);
    assert.equal(resolvedSnap.execApprovals[0].status, "allowed");
    assert.deepEqual(gw.getApprovalResolved(), {
      id: "appr_exec_99",
      kind: "exec",
      decision: "allow-once",
    });

    // 5. Verify `steer_turn` (`chat.send` with `queueMode: "steer"`) and `stop_turn` (`chat.abort` without `sessionId`)
    await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "steer_turn",
          conversationId: configured.activeConversationId,
          prompt: "Focus on outerwear sizing",
        },
      }),
    );
    assert.equal(gw.getSteerSend()?.queueMode, "steer");

    await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "stop_turn",
          conversationId: configured.activeConversationId,
        },
      }),
    );
    assert.ok(gw.getChatAbort()?.sessionKey);
    assert.equal("sessionId" in (gw.getChatAbort() ?? {}), false, "2026.11.1 chat.abort must never send sessionId");

    // 6. Verify `/pair` MCP `tools/call` rejects unauthenticated callers and accepts valid Bearer token!
    const unauthMcp = await pair(
      makeCtx({
        role: 0,
        sharedSettings,
        sharedKv,
        input: {
          jsonrpc: "2.0",
          id: 77,
          method: "tools/call",
          params: { name: "openclaw_list_collections", arguments: {} },
        },
      }),
    );
    assert.equal(unauthMcp.error.code, -32001);

    const authMcp = await pair(
      makeCtx({
        role: 0,
        sharedSettings,
        sharedKv,
        headers: { authorization: "Bearer oc_live_secret_bootstrap_999" },
        input: {
          jsonrpc: "2.0",
          id: 78,
          method: "tools/call",
          params: { name: "openclaw_list_collections", arguments: {} },
        },
      }),
    );
    assert.ok(authMcp.result);

    // 7. External `/pair` proposals submitted AFTER `revision_proposals_v2` exists are ingested,
    //    visible to any admin via `conv_default`, and summary-only imports cannot vacuously apply!
    await pair(
      makeCtx({
        role: 0,
        sharedSettings,
        sharedKv,
        headers: { authorization: "Bearer oc_live_secret_bootstrap_999" },
        input: {
          jsonrpc: "2.0",
          id: 79,
          method: "tools/call",
          params: {
            name: "emdash_submit_proposal",
            arguments: { summary: "Summary-only note from external CLI" },
          },
        },
      }),
    );

    const otherAdminSnap = await chat(
      makeCtx({
        role: 50,
        userId: "u_other_admin",
        sharedSettings,
        sharedKv,
        input: { action: "get_workspace" },
      }),
    );
    const summaryOnlyProp = otherAdminSnap.proposals.find(
      p => p.summary === "Summary-only note from external CLI",
    );
    assert.ok(summaryOnlyProp, "External proposal must ingest even after v2 store exists");
    assert.equal(summaryOnlyProp.conversationId, "conv_default");
    assert.deepEqual(summaryOnlyProp.proposedFields, {});

    const vacuousApplyAttempt = await chat(
      makeCtx({
        role: 50,
        userId: "u_other_admin",
        sharedSettings,
        sharedKv,
        input: {
          action: "record_proposal_receipt",
          proposalId: summaryOnlyProp.proposalId,
          status: "applied",
        },
      }),
    );
    assert.equal(vacuousApplyAttempt.ok, false);
    assert.equal(vacuousApplyAttempt.error, "NO_CONCRETE_PATCH");

    await pair(
      makeCtx({
        role: 0,
        sharedSettings,
        sharedKv,
        headers: { authorization: "Bearer oc_live_secret_bootstrap_999" },
        input: {
          action: "propose",
          collection: "products",
          entryId: "prod_01",
          summary: "Concrete external patch",
          proposedFields: { excerpt: "External agent waxed cotton copy", seoTitle: "Ignored SEO" },
        },
      }),
    );
    const afterConcreteSnap = await chat(
      makeCtx({
        role: 50,
        userId: "u_other_admin",
        sharedSettings,
        sharedKv,
        input: { action: "get_workspace" },
      }),
    );
    const concreteExt = afterConcreteSnap.proposals.find(
      p => p.summary === "Concrete external patch",
    );
    assert.ok(concreteExt);
    assert.equal(concreteExt.proposedFields.excerpt, "External agent waxed cotton copy");
    assert.equal("seoTitle" in concreteExt.proposedFields, false);

    // Cleanly disconnect Gateway client before closing server
    await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: { action: "disconnect" },
      }),
    );
  } finally {
    await gw.close();
  }
});

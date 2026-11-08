import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createPlugin } from "../dist/native.mjs";
import { GET as streamGet } from "../dist/stream-endpoint.mjs";

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
        assert.ok(
          frame.params.caps?.includes("tool-events"),
          "GatewayClient must advertise tool-events capability",
        );
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

test("Gateway bridge isolates steer terminal events, honours Gateway approval/abort outcomes, protects shared->personal setup audience, and re-subscribes on reconnect", async () => {
  const subscribeLog = [];
  let pauseSubscribe = null;
  let nextAbortFails = false;
  let mainWs = null;
  let releaseOriginatingFinal = null;

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", ws => {
    mainWs = ws;
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce_edge_v4", ts: Date.now() },
      }),
    );

    ws.on("message", async raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        assert.ok(frame.params.caps?.includes("tool-events"));
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "2026.11.1-edge", connId: `conn_${Date.now()}` },
              features: {
                methods: [
                  "chat.send",
                  "chat.abort",
                  "sessions.messages.subscribe",
                  "approval.resolve",
                ],
                events: ["chat", "agent", "session.approval"],
              },
              auth: {
                deviceToken: "oc_dev_edge",
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.approvals"],
              },
              policy: { maxPayload: 1048576, maxBufferedBytes: 4194304, tickIntervalMs: 30000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "sessions.messages.subscribe") {
        const subKey = frame.params.key ?? frame.params.sessionKey;
        subscribeLog.push(subKey);
        if (pauseSubscribe) {
          await pauseSubscribe;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { subscribed: true, key: subKey, sessionKey: subKey },
          }),
        );
        return;
      }

      if (frame.method === "chat.send") {
        const sessionKey = frame.params.sessionKey;
        if (frame.params.queueMode === "steer") {
          const steerRunId = "run_steer_child_99";
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: steerRunId, status: "started" },
            }),
          );
          // Steer run finishes IMMEDIATELY with its own `final` event — must NOT finish originating run!
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId: steerRunId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                  message: { role: "assistant", content: "STEER_ACK_ONLY" },
                },
              }),
            );
          }, 10);
          return;
        }

        const origRunId = "run_originating_01";
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: origRunId, status: "started" },
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
                id: "appr_race_denied",
                status: "pending",
                createdAtMs: Date.now(),
                presentation: {
                  kind: "exec",
                  agentId: "roboclaw",
                  title: "Contested exec approval",
                  commandText: "echo test",
                  allowedDecisions: ["allow-once", "deny"],
                },
              },
            },
          }),
        );

        ws.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: origRunId,
              sessionKey,
              seq: 1,
              state: "delta",
              deltaText: "Confidential Gateway Delta ",
            },
          }),
        );

        if (releaseOriginatingFinal) {
          await releaseOriginatingFinal;
        }

        ws.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: origRunId,
              sessionKey,
              seq: 2,
              state: "final",
              message: {
                role: "assistant",
                content: "Originating run complete after steer.",
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "approval.resolve") {
        // Simulate another admin already denied it on Gateway (`applied: false` + recorded `denied` state)
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              applied: false,
              approval: {
                id: frame.params.id,
                status: "denied",
                decision: "deny",
                resolvedAtMs: Date.now(),
                presentation: {
                  kind: "exec",
                  agentId: "roboclaw",
                  title: "Contested exec approval",
                  commandText: "echo test",
                  allowedDecisions: ["allow-once", "deny"],
                },
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "chat.abort") {
        if (nextAbortFails) {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { ok: true, aborted: false, runIds: [] },
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true, aborted: true, runIds: ["run_originating_01"] },
          }),
        );
      }
    });
  });

  await new Promise(r => wss.on("listening", r));
  const port = wss.address().port;
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();

  try {
    await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          action: "configure_connection",
          gatewayUrl: `ws://127.0.0.1:${port}`,
          gatewayToken: "oc_edge_tok",
          agentId: "roboclaw",
          authorityMode: "propose_with_approval",
          allowGatewayExecApprovals: true,
        },
      }),
    );

    const sharedThreadSnap = await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: { action: "create_thread", title: "Gateway Steer & Privacy", visibility: "shared" },
      }),
    );
    const convId = sharedThreadSnap.activeConversationId;

    const bobAbort = new AbortController();
    const bobStream = await streamGet({
      request: new Request("http://localhost:4321/_emdash/api/openclaw/stream", {
        signal: bobAbort.signal,
      }),
      url: new URL("http://localhost:4321/_emdash/api/openclaw/stream"),
      locals: { user: { id: "u_bob", role: 40 } },
    });
    const bobReader = bobStream.body.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await bobReader.read()).value), /"type":"connected"/);

    // Pause Gateway subscribe AND pause originating final so we test:
    // (a) shared -> personal toggle while bridge setup is in flight
    // (b) steer's terminal `final` event NOT prematurely resolving originating turn
    // (c) failed `chat.abort` NOT marking the active turn `"stopped"`
    let unblockSub;
    pauseSubscribe = new Promise(r => {
      unblockSub = r;
    });
    let unblockOrigFinal;
    releaseOriginatingFinal = new Promise(r => {
      unblockOrigFinal = r;
    });

    const origTurnPromise = chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: {
          action: "send_message",
          conversationId: convId,
          prompt: "Audit jacket sizing",
        },
      }),
    );

    // Drain Bob's initial `turn_started` + `tool_call` frames before toggling privacy
    await new Promise(r => setTimeout(r, 35));

    // Toggle shared -> personal BEFORE `sessions.messages.subscribe` completes!
    await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: { action: "toggle_thread_visibility", conversationId: convId },
      }),
    );

    pauseSubscribe = null;
    unblockSub();
    await new Promise(r => setTimeout(r, 40));

    // Send a mid-run steer whose own `run_steer_child_99` emits `state: "final"` immediately
    await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: {
          action: "steer_turn",
          conversationId: convId,
          prompt: "Include chest measurements",
        },
      }),
    );
    await new Promise(r => setTimeout(r, 40));

    // Verify originating turn has NOT prematurely completed on steer's `final`!
    let origSettledEarly = false;
    origTurnPromise.then(() => {
      origSettledEarly = true;
    });
    await new Promise(r => setTimeout(r, 25));
    assert.equal(origSettledEarly, false, "Steer terminal event must not finish originating turn");

    // Failed `chat.abort` (`aborted: false`) must return STOP_FAILED and leave thread `running`!
    nextAbortFails = true;
    const failedStop = await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: { action: "stop_turn", conversationId: convId },
      }),
    );
    assert.equal(failedStop.ok, false);
    assert.equal(failedStop.error, "STOP_FAILED");
    const afterFailedStopSnap = await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: { action: "get_workspace", conversationId: convId },
      }),
    );
    assert.equal(
      afterFailedStopSnap.threads.find(t => t.conversationId === convId)?.status,
      "running",
      "Failed Gateway abort must not display thread as stopped",
    );

    // Attempt `allow-once` when Gateway returns `applied: false` with recorded `denied` state
    const contestedApprovalRes = await chat(
      makeCtx({
        role: 50,
        userId: "u_admin",
        sharedSettings,
        sharedKv,
        input: {
          action: "resolve_gateway_approval",
          conversationId: convId,
          approvalId: "appr_race_denied",
          kind: "exec",
          decision: "allow-once",
        },
      }),
    );
    assert.equal(contestedApprovalRes.ok, false);
    assert.equal(contestedApprovalRes.error, "GATEWAY_APPROVAL_FAILED");

    const aliceSnapWithApproval = await chat(
      makeCtx({
        role: 40,
        userId: "u_alice",
        sharedSettings,
        sharedKv,
        input: { action: "get_workspace", conversationId: convId },
      }),
    );
    const recordedAppr = aliceSnapWithApproval.execApprovals.find(
      a => a.approvalId === "appr_race_denied",
    );
    assert.equal(
      recordedAppr?.status,
      "denied",
      "Recorded Gateway decision must win over locally attempted allow-once",
    );
    assert.equal(recordedAppr?.decision, "deny");

    // Now let originating run finish and confirm it gets the originating reply, NOT `STEER_ACK_ONLY`!
    releaseOriginatingFinal = null;
    unblockOrigFinal();
    const completedOrig = await origTurnPromise;
    const finishedThread = completedOrig.threads.find(t => t.conversationId === convId);
    assert.ok(
      finishedThread.messages.some(
        m => m.role === "assistant" && m.content === "Originating run complete after steer.",
      ),
    );
    assert.equal(
      finishedThread.messages.some(m => m.content.includes("STEER_ACK_ONLY")),
      false,
    );

    // Emit a shared ping and verify Bob NEVER received `Confidential Gateway Delta`!
    await chat(
      makeCtx({
        role: 50,
        userId: "u_admin",
        sharedSettings,
        sharedKv,
        input: {
          action: "configure_connection",
          gatewayUrl: `ws://127.0.0.1:${port}`,
          gatewayToken: "oc_edge_tok",
          agentId: "roboclaw",
        },
      }),
    );
    let bobAll = "";
    while (!bobAll.includes('"reason":"connection_updated"')) {
      bobAll += decoder.decode((await bobReader.read()).value);
    }
    assert.doesNotMatch(bobAll, /Confidential Gateway Delta/);
    bobAbort.abort();

    // Test Gateway WS reconnect recovery: terminate socket -> GatewayClient reconnects & re-subscribes!
    const subsBeforeDrop = subscribeLog.length;
    mainWs.close();
    const deadline = Date.now() + 5_000;
    while (subscribeLog.length <= subsBeforeDrop && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 80));
    }
    assert.ok(
      subscribeLog.length > subsBeforeDrop,
      "Bridge must re-subscribe known sessions automatically after WS reconnect",
    );
  } finally {
    await chat(
      makeCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: { action: "disconnect" },
      }),
    ).catch(() => {});
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(() => r()));
  }
});

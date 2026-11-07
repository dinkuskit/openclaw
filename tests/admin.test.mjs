import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";

const admin = plugin.routes.admin.handler;

function createHost({ role = 50, initialConnection = null, initialProposals = [] } = {}) {
  const stored = new Map();
  if (initialConnection) {
    stored.set("connection", { value: JSON.stringify(initialConnection), revision: "1" });
  }
  const kv = new Map();
  if (initialProposals.length > 0) {
    kv.set("pending_proposals", initialProposals);
  }
  let revisions = 1;
  const ctx = {
    plugin: { id: "dinkus-openclaw", version: "0.0.0" },
    site: { url: "https://shop.example.test", name: "Shop", locale: "en" },
    settings: {
      get: async name => stored.get(name)?.value ?? null,
      delete: async name => stored.delete(name),
      getVersioned: async name => stored.get(name) ?? null,
      compareAndSet: async (name, revision, value) => {
        if ((stored.get(name)?.revision ?? null) !== revision) return { applied: false };
        stored.set(name, { value, revision: String(++revisions) });
        return { applied: true };
      },
    },
    kv: {
      get: async name => (kv.has(name) ? kv.get(name) : null),
      set: async (name, value) => {
        kv.set(name, value);
      },
      delete: async name => kv.delete(name),
    },
    http: {
      fetch: async () => Response.json({ ok: true }),
    },
    log: { error() {}, info() {}, warn() {}, debug() {} },
  };
  const route = input => ({
    input,
    ui: { surface: "admin-page", locale: "en", direction: "ltr" },
    user: { id: "u1", email: "owner@example.test", name: "Owner", role, createdAt: "" },
    request: { url: "https://shop.example.test/_emdash/api/plugins/dinkus-openclaw/admin", method: "POST", headers: {} },
  });
  return { ctx, route, stored, kv };
}

test("refuses callers below Editor role with valid Block Kit", async () => {
  const { ctx, route } = createHost({ role: 10 });
  const response = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(response));
  assert.equal(response.blocks[1].type, "banner");
  assert.equal(response.blocks[1].title, "Permission denied");
});

test("renders OpenClaw setup form on unconfigured load and saves connection", async () => {
  const { ctx, route } = createHost({ role: 50 });
  const initial = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(initial));
  assert.equal(initial.blocks.some(b => b.type === "form" && b.block_id === "openclaw-connect-form"), true);

  const connected = await admin(
    route({
      type: "form_submit",
      action_id: "save_connection",
      values: {
        gatewayUrl: "https://dinkuskit.com/api/openclaw",
        agentId: "blaze",
        gatewayToken: "oc_test_token_123",
        authorityMode: "propose_with_approval",
      },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(connected));
  assert.equal(connected.toast?.type, "success");
  assert.equal(connected.blocks.some(b => b.type === "form" && b.block_id === "openclaw-prompt-form"), true);
});

test("renders WAITING_FOR_HUMAN approval cards and resolves approval", async () => {
  const { ctx, route } = createHost({
    role: 50,
    initialConnection: {
      gatewayUrl: "https://dinkuskit.com/api/openclaw",
      agentId: "blaze",
      gatewayToken: "oc_test_token_123",
      authorityMode: "propose_with_approval",
    },
    initialProposals: [
      {
        proposalId: "prop_1",
        agentId: "blaze",
        summary: "Update homepage hero draft headline",
        targetTool: "admin.editor-draft:patch",
        createdAt: "2026-11-07T15:00:00Z",
      },
    ],
  });

  const page = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(page));
  assert.equal(
    page.blocks.some(b => b.type === "header" && b.text.includes("WAITING_FOR_HUMAN")),
    true,
  );

  const approved = await admin(
    route({
      type: "block_action",
      action_id: "approve_proposal",
      value: "prop_1",
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(approved));
  assert.equal(approved.toast?.message, "Approved proposal prop_1.");
});

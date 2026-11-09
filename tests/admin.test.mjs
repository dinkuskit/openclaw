import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { adaptSandboxEntry } from "../node_modules/emdash/dist/plugins/adapt-sandbox-entry.mjs";

const admin = plugin.routes.admin.handler;
const editorPanel = plugin.routes["editor/assistant"].handler;
const pairRoute = plugin.routes.pair.handler;

function createHost({
  role = 50,
  initialConnection = null,
  initialProposals = [],
  collections = [
    { slug: "pages", label: "Pages" },
    { slug: "posts", label: "Blog Posts" },
    { slug: "products", label: "Products" },
  ],
} = {}) {
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
    site: { url: "https://site.example.test", name: "Example Site", locale: "en" },
    schema: {
      listCollections: async () => collections,
    },
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
  const route = (input, entry = undefined) => ({
    input,
    ui: { surface: entry ? "editor-panel" : "admin-page", locale: "en", direction: "ltr", ...(entry ? { entry } : {}) },
    user: { id: "u1", email: "owner@example.test", name: "Owner", role, createdAt: "" },
    request: { url: "https://site.example.test/_emdash/api/plugins/dinkus-openclaw/admin", method: "POST", headers: {} },
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

test("discovers dynamic site collections without requiring Commerce and saves connection", async () => {
  const { ctx, route } = createHost({
    role: 50,
    collections: [
      { slug: "pages", label: "Pages" },
      { slug: "articles", label: "Articles" },
    ],
  });
  const initial = await admin(route({ type: "page_load" }), ctx);
  assert.doesNotThrow(() => validateBlockResponse(initial));
  const colsBlock = initial.blocks.find(b => b.type === "columns");
  assert.ok(colsBlock);
  const codeBlock = colsBlock.columns[0].find(b => b.type === "code");
  assert.ok(codeBlock);
  assert.match(codeBlock.code, /\/_emdash\/api\/plugins\/dinkus-openclaw\/pair/);
  assert.match(codeBlock.code, /X-OpenClaw-Token/);
  assert.doesNotMatch(codeBlock.code, /Authorization:\s*Bearer/i);
  const accordion = colsBlock.columns[1].find(b => b.type === "accordion");
  assert.ok(accordion);
  const form = accordion.blocks.find(b => b.type === "form" && b.block_id === "openclaw-connect-form");
  assert.ok(form);
  const checkboxField = form.fields.find(f => f.action_id === "enabledCollections");
  assert.ok(checkboxField);
  assert.equal(checkboxField.options.some(o => o.value === "articles"), true);

  // Also verify 1-step agent pairing via the public pair route (zero gatewayUrl/token needed)
  const pairingCode = await ctx.kv.get("pairing_code");
  const pairResp = await pairRoute(
    route({
      pairingCode,
      agentId: "blaze",
      authorityMode: "propose_with_approval",
    }),
    ctx,
  );
  assert.equal(pairResp.ok, true);
  assert.equal(typeof pairResp.sessionToken, "string");
  assert.equal(pairResp.authHeader, "X-OpenClaw-Token");

  // Verify real EmDash 1.4.0 sandbox dispatch (`sanitizeHeadersForSandbox` strips Authorization,
  // while `X-OpenClaw-Token` and JSON `sessionToken` reach the sandboxed `/pair` handler).
  const sandboxResolved = adaptSandboxEntry(plugin, { id: "dinkus-openclaw", version: "0.0.0" });
  const invokeSandboxPair = (input, headerEntries) =>
    sandboxResolved.routes.pair.handler({
      ...ctx,
      input,
      user: undefined,
      ui: undefined,
      requestMeta: {},
      request: {
        url: "https://site.example.test/_emdash/api/plugins/dinkus-openclaw/pair",
        method: "POST",
        headers: new Headers(headerEntries),
      },
    });

  const strippedBearerMcp = await invokeSandboxPair(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "emdash_status", arguments: {} },
    },
    { Authorization: `Bearer ${pairResp.sessionToken}` },
  );
  assert.equal(strippedBearerMcp.error.code, -32001);
  assert.match(strippedBearerMcp.error.message, /X-OpenClaw-Token/);

  const sandboxHeaderMcp = await invokeSandboxPair(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "emdash_status", arguments: {} },
    },
    { "X-OpenClaw-Token": pairResp.sessionToken },
  );
  assert.ok(sandboxHeaderMcp.result);

  const sandboxHeaderPoll = await invokeSandboxPair(
    { action: "poll_turn" },
    { "X-OpenClaw-Token": pairResp.sessionToken },
  );
  assert.equal(sandboxHeaderPoll.ok, true);
  assert.equal(sandboxHeaderPoll.agentId, "blaze");

  // Also verify built-in MCP JSON-RPC initialize + tools/list sessionToken schema on the pair route
  const mcpInit = await pairRoute(
    route({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    }),
    ctx,
  );
  assert.equal(mcpInit.jsonrpc, "2.0");
  assert.ok(mcpInit.result);

  const mcpList = await pairRoute(
    route({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }),
    ctx,
  );
  for (const tool of mcpList.result.tools) {
    assert.equal(tool.inputSchema.properties.sessionToken.type, "string");
  }

  const connected = await admin(
    route({
      type: "form_submit",
      action_id: "save_connection",
      values: {
        gatewayUrl: "https://gateway.example.com",
        agentId: "blaze",
        gatewayToken: "oc_test_token_123",
        authorityMode: "propose_with_approval",
        enabledCollections: ["pages"],
      },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(connected));
  assert.equal(connected.toast?.type, "success");
});

test("supports live mid-task steer and configurable editor side-panel collaboration", async () => {
  const { ctx, route } = createHost({
    role: 50,
    initialConnection: {
      gatewayUrl: "https://gateway.example.com",
      agentId: "blaze",
      gatewayToken: "oc_test_token_123",
      authorityMode: "propose_with_approval",
      enabledCollections: ["pages"],
    },
  });

  const started = await admin(
    route({
      type: "form_submit",
      action_id: "ask_agent",
      values: { prompt: "Audit all landing pages for broken CTAs" },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(started));
  const tabBlock = started.blocks.find(b => b.type === "tab");
  assert.ok(tabBlock);
  const assistantCols = tabBlock.panels[0].blocks.find(b => b.type === "columns");
  assert.ok(assistantCols);
  assert.equal(
    assistantCols.columns[1].some(b => b.type === "form" && b.block_id === "openclaw-steer-form"),
    true,
  );

  const steered = await admin(
    route({
      type: "form_submit",
      action_id: "steer_agent",
      values: { steerMessage: "Focus on the pricing page first" },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(steered));
  assert.equal(steered.toast?.type, "info");

  // Enabled collection ("pages") renders collaboration form in editor panel
  const pagesPanel = await editorPanel(
    route({ type: "panel_load" }, { collection: "pages", id: "home", locale: "en", version: 1 }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(pagesPanel));
  assert.equal(pagesPanel.blocks.some(b => b.type === "form" && b.block_id === "openclaw-entry-form"), true);

  // Disabled collection ("posts") respects collection filter
  const postsPanel = await editorPanel(
    route({ type: "panel_load" }, { collection: "posts", id: "post-1", locale: "en", version: 1 }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(postsPanel));
  assert.equal(postsPanel.blocks.some(b => b.type === "form"), false);

  // Reject URL-embedded credentials on Block Kit save_connection
  const rejectedUserinfo = await admin(
    route({
      type: "form_submit",
      action_id: "save_connection",
      values: {
        gatewayUrl: "https://user:secret@openclaw.example.test",
        agentId: "openclaw",
        gatewayToken: "oc_tok",
        authorityMode: "read_only",
      },
    }),
    ctx,
  );
  assert.doesNotThrow(() => validateBlockResponse(rejectedUserinfo));
  assert.equal(rejectedUserinfo.blocks[1].type, "banner");
});

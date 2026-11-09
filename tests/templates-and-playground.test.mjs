import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import pluginSandbox from "../dist/plugin.mjs";
import {
  BLOBSTER_CATALOG_URL,
  BLOBSTER_SUBMIT_URL,
  FEATURED_AGENT_TEMPLATES,
  OPENCLAW_ENABLE_TEMPLATES_CMD,
  buildAgentTemplateInstallCommands,
  createPlugin,
  isNodeGatewayBridgeSupportedRuntime,
  resolvePlaygroundVisitorHash,
} from "../dist/native.mjs";
import { createPlugin as createWorkerdPlugin } from "../dist/native.workerd.mjs";

function createPlaygroundRouteCtx({
  userId = "u_playground",
  role = 50,
  input = {},
  headers = {},
  collections = [
    { slug: "templates", label: "Agent Templates", supports: ["revisions", "drafts"] },
    { slug: "pages", label: "Pages", supports: ["revisions", "drafts"] },
    { slug: "posts", label: "Posts", supports: ["revisions", "drafts"] },
  ],
  itemsByCollection = {
    templates: [
      {
        id: "tpl_smith",
        slug: "blobster-smith",
        status: "published",
        version: 1,
        data: {
          title: "Blobster Smith",
          excerpt: "Anvil Forgemaster for OpenClaw Agent Templates.",
        },
      },
    ],
    pages: [
      {
        id: "page_home",
        slug: "home",
        status: "published",
        version: 1,
        data: {
          title: "Blobster Factory",
          excerpt: "Forge and share verified OpenClaw agents.",
        },
      },
    ],
  },
  sharedSettings = new Map(),
  sharedKv = new Map(),
  includeCtxHttp = false,
  ctxHttpFetch = async () => Response.json({ ok: true }),
} = {}) {
  let revCounter = 1;
  return {
    input,
    user: { id: userId, email: `${userId}@playground.test`, name: "Playground Visitor", role },
    ui: { surface: "admin-page", locale: "en", direction: "ltr" },
    request: {
      url: "https://dev.blobster.dev/_emdash/api/plugins/dinkus-openclaw/chat",
      method: "POST",
      headers: new Headers(headers),
    },
    site: { url: "https://dev.blobster.dev", name: "Blobster Factory", locale: "en" },
    schema: {
      listCollections: async () => collections,
    },
    content: {
      list: async slug => ({ items: itemsByCollection[slug] ?? [] }),
      get: async (slug, id) => (itemsByCollection[slug] ?? []).find(i => i.id === id) ?? null,
    },
    settings: {
      get: async k => sharedSettings.get(k)?.value ?? null,
      delete: async k => sharedSettings.delete(k),
      getVersioned: async k => sharedSettings.get(k) ?? null,
      compareAndSet: async (k, expectedRev, value) => {
        if ((sharedSettings.get(k)?.revision ?? null) !== expectedRev) return { applied: false };
        sharedSettings.set(k, { value, revision: String(++revCounter) });
        return { applied: true };
      },
    },
    kv: {
      get: async k => (sharedKv.has(k) ? sharedKv.get(k) : null),
      set: async (k, v) => {
        sharedKv.set(k, v);
      },
      delete: async k => sharedKv.delete(k),
    },
    ...(includeCtxHttp ? { http: { fetch: ctxHttpFetch } } : {}),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

function clearPlaygroundEnv() {
  delete globalThis.__openclawPlaygroundEnv;
  for (const key of [
    "OPENCLAW_PLAYGROUND_GATEWAY_URL",
    "OPENCLAW_PLAYGROUND_GATEWAY_TOKEN",
    "OPENCLAW_PLAYGROUND_AGENT_ID",
    "OPENCLAW_PLAYGROUND_ENABLED_COLLECTIONS",
    "OPENCLAW_PLAYGROUND_LOCK",
    "OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_ID",
    "OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_SECRET",
  ]) {
    delete process.env[key];
  }
}

test("Agent Templates metadata, CLI helper commands, Block Kit sections, and SolidJS UI bundle", async () => {
  assert.equal(BLOBSTER_CATALOG_URL, "https://blobster.dev");
  assert.equal(BLOBSTER_SUBMIT_URL, "https://blobster.dev/submit");
  assert.equal(
    OPENCLAW_ENABLE_TEMPLATES_CMD,
    "openclaw config set gateway.controlUi.experimental.templates true",
  );
  assert.equal(FEATURED_AGENT_TEMPLATES.length >= 2, true);

  const smith = FEATURED_AGENT_TEMPLATES.find(t => t.id === "blobster-smith");
  const sculptor = FEATURED_AGENT_TEMPLATES.find(t => t.id === "blobster-sculptor");
  assert.ok(smith);
  assert.ok(sculptor);
  assert.equal(smith.name, "Blobster Smith · Anvil Forgemaster");
  assert.equal(smith.packageUrl, "https://blobster.dev/t/blobster-smith.tgz");
  assert.equal(smith.detailUrl, "https://blobster.dev/templates/blobster-smith");
  assert.equal(
    smith.installCommand,
    "openclaw templates add https://blobster.dev/t/blobster-smith.tgz",
  );
  assert.equal(sculptor.name, "Blobster Sculptor · Avatar & Identity Rig");
  assert.equal(sculptor.packageUrl, "https://blobster.dev/t/blobster-sculptor.tgz");
  assert.equal(
    sculptor.installCommand,
    "openclaw templates add https://blobster.dev/t/blobster-sculptor.tgz",
  );

  // 1. Helper supports slug, .tgz URL, and local path + shell escaping
  const fromSlug = buildAgentTemplateInstallCommands(
    "blobster-smith",
    "https://dev.blobster.dev",
    "oc_pair_abc123",
  );
  assert.equal(fromSlug.sourceKind, "catalog-slug");
  assert.equal(fromSlug.agentId, "blobster-smith");
  assert.equal(
    fromSlug.installCommand,
    "openclaw templates add https://blobster.dev/t/blobster-smith.tgz",
  );
  assert.match(fromSlug.enableTemplatesCommand, /gateway\.controlUi\.experimental\.templates true/);
  assert.match(fromSlug.harnessCommand, /--agent-id blobster-smith/);
  assert.match(fromSlug.pairCommand, /"agentId":"blobster-smith"/);
  assert.match(fromSlug.pairCommand, /"pairingCode":"oc_pair_abc123"/);

  const fromUrl = buildAgentTemplateInstallCommands(
    "https://example.com/releases/custom-curator-1.2.0.tgz",
    "https://store.example.com",
  );
  assert.equal(fromUrl.sourceKind, "tarball-url");
  assert.equal(fromUrl.agentId, "custom-curator");
  assert.equal(
    fromUrl.installCommand,
    "openclaw templates add https://example.com/releases/custom-curator-1.2.0.tgz",
  );
  assert.match(fromUrl.pairCommand, /<PAIRING_CODE>/);

  const fromLocal = buildAgentTemplateInstallCommands(
    "./agents/my local'agent",
    "https://store.example.com",
  );
  assert.equal(fromLocal.sourceKind, "local-path");
  assert.equal(fromLocal.agentId, "my-local-agent");
  assert.equal(
    fromLocal.validateCommand,
    `openclaw templates validate './agents/my local'\\''agent'`,
  );
  assert.equal(fromLocal.installCommand, `openclaw templates add './agents/my local'\\''agent'`);

  // 2. Snapshot exposes featured templates & catalog URLs
  clearPlaygroundEnv();
  const resolved = createPlugin();
  const snap = await resolved.routes.chat.handler(
    createPlaygroundRouteCtx({ input: { action: "get_workspace" } }),
  );
  assert.equal(snap.catalogUrl, "https://blobster.dev");
  assert.equal(snap.submitUrl, "https://blobster.dev/submit");
  assert.equal(snap.agentTemplates.length, FEATURED_AGENT_TEMPLATES.length);
  assert.equal(snap.agentTemplates[0].id, "blobster-smith");

  // 3. Sandboxed Block Kit renders valid Agent Templates section on BOTH setupPage & workspacePage
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const adminHandler = pluginSandbox.routes.admin.handler;
  const setupRes = await adminHandler(
    { input: { type: "page_load" }, user: { id: "u1", role: 50 }, request: { url: "https://dev.blobster.dev/_emdash" } },
    createPlaygroundRouteCtx({ sharedSettings, sharedKv }),
  );
  assert.doesNotThrow(() => validateBlockResponse(setupRes));
  const setupJson = JSON.stringify(setupRes);
  assert.match(setupJson, /openclaw templates add https:\/\/blobster\.dev\/t\/blobster-smith\.tgz/);
  assert.match(setupJson, /https:\/\/blobster\.dev\/submit/);

  sharedSettings.set("connection", {
    value: JSON.stringify({
      gatewayUrl: "https://gateway.example.com",
      agentId: "blobster-smith",
      gatewayToken: "oc_tok_123",
      authorityMode: "propose_with_approval",
      enabledCollections: ["templates", "pages"],
    }),
    revision: "1",
  });
  const connectedRes = await adminHandler(
    { input: { type: "page_load" }, user: { id: "u1", role: 50 }, request: { url: "https://dev.blobster.dev/_emdash" } },
    createPlaygroundRouteCtx({ sharedSettings, sharedKv }),
  );
  assert.doesNotThrow(() => validateBlockResponse(connectedRes));
  const connectedJson = JSON.stringify(connectedRes);
  assert.match(connectedJson, /Agent Templates \(blobster\.dev\)/);
  assert.match(
    connectedJson,
    /openclaw templates add https:\/\/blobster\.dev\/t\/blobster-smith\.tgz/,
  );

  // 4. Precompiled `<openclaw-emdash-chat>` bundle contains Agent Templates UI controls & links
  const uiBundle = fs.readFileSync(new URL("../dist/admin.mjs", import.meta.url), "utf8");
  assert.match(uiBundle, /Browse verified Agent Templates on Blobster Factory/);
  assert.match(uiBundle, /Submit an Agent Template/);
  assert.match(uiBundle, /Use Agent ID/);
  assert.match(uiBundle, /blobster-sculptor/);
});

test("Cloudflare Workers (workerd) entrypoints avoid eager Node ws/tls imports and detect Workers runtime", () => {
  const workerdNativeCode = fs.readFileSync(
    new URL("../dist/native.workerd.mjs", import.meta.url),
    "utf8",
  );
  const streamCode = fs.readFileSync(
    new URL("../dist/stream-endpoint.mjs", import.meta.url),
    "utf8",
  );

  for (const [label, code] of [
    ["dist/native.workerd.mjs", workerdNativeCode],
    ["dist/stream-endpoint.mjs", streamCode],
  ]) {
    assert.doesNotMatch(code, /@openclaw\/gateway-client/, `${label} must not import gateway-client`);
    assert.doesNotMatch(code, /from\s+["']ws["']/, `${label} must not import Node ws`);
    assert.doesNotMatch(code, /node:tls|node:net|node:crypto/, `${label} must be pure Web-standard ESM`);
  }

  const workerdResolved = createWorkerdPlugin();
  assert.equal(workerdResolved.id, "dinkus-openclaw");
  assert.ok(workerdResolved.routes.chat);

  // Verify runtime detector returns false when WebSocketPair or Cloudflare-Workers userAgent is present
  assert.equal(isNodeGatewayBridgeSupportedRuntime(), true);
  globalThis.WebSocketPair = function MockWebSocketPair() {};
  try {
    assert.equal(isNodeGatewayBridgeSupportedRuntime(), false);
  } finally {
    delete globalThis.WebSocketPair;
  }
});

test("OPENCLAW_PLAYGROUND_* env mode, globalThis.fetch + CF-Access headers, lock enforcement, and per-visitor cookie sessionKey hashing", async () => {
  clearPlaygroundEnv();
  const origFetch = globalThis.fetch;
  const outboundCalls = [];

  globalThis.fetch = async (url, init) => {
    outboundCalls.push({
      url: String(url),
      headers: init?.headers,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Response.json({
      choices: [
        {
          message: {
            content:
              'Forged a crisp update from Blobster Smith!\n\n```emdash-proposal\n{"collection":"templates","entryId":"tpl_smith","summary":"Sharpen Blobster Smith tagline","proposedFields":{"excerpt":" Forgemaster for verified OpenClaw Agent Templates."}}\n```',
          },
        },
      ],
    });
  };

  try {
    globalThis.__openclawPlaygroundEnv = {
      OPENCLAW_PLAYGROUND_GATEWAY_URL: "https://gateway-playground.example.test",
      OPENCLAW_PLAYGROUND_GATEWAY_TOKEN: "oc_secret_playground_gateway_token_999",
      OPENCLAW_PLAYGROUND_AGENT_ID: "blobster-smith",
      OPENCLAW_PLAYGROUND_ENABLED_COLLECTIONS: "templates,pages",
      OPENCLAW_PLAYGROUND_LOCK: "1",
      OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_ID: "cf_client_id_test.access",
      OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_SECRET: "cf_client_secret_super_private",
    };

    const plugin = createWorkerdPlugin();
    const chat = plugin.routes.chat.handler;
    const admin = plugin.routes.admin.handler;
    const pair = plugin.routes.pair.handler;

    const sharedSettings = new Map();
    const sharedKv = new Map();

    // 1. Workspace snapshot auto-connects without writing secrets to SQLite or exposing tokens/CF secrets
    const visitorACookie = "emdash_playground=visitor_alpha_cookie_001; theme=dark";
    const expectedHashA = crypto
      .createHash("sha256")
      .update("visitor_alpha_cookie_001")
      .digest("hex")
      .slice(0, 12);

    const computedHash = await resolvePlaygroundVisitorHash({
      request: { headers: new Headers({ cookie: visitorACookie }) },
    });
    assert.equal(computedHash, expectedHashA);

    const snapA = await chat(
      createPlaygroundRouteCtx({
        role: 50,
        headers: { cookie: visitorACookie },
        sharedSettings,
        sharedKv,
        includeCtxHttp: false, // Native plugin has no ctx.http!
        input: { action: "get_workspace" },
      }),
    );

    assert.equal(snapA.paired, true);
    assert.equal(snapA.playgroundMode, true);
    assert.equal(snapA.playgroundLocked, true);
    assert.equal(snapA.canResolveGatewayApprovals, false);
    assert.equal(snapA.pairingCode, "");
    assert.equal(snapA.pairingCommand, "");
    assert.equal(snapA.connection.agentId, "blobster-smith");
    assert.equal(snapA.connection.authorityMode, "propose_with_approval");
    assert.equal(snapA.connection.allowGatewayExecApprovals, false);
    assert.deepEqual(snapA.connection.enabledCollections, ["templates", "pages"]);
    assert.equal(snapA.gatewayBridge.available, true);
    assert.equal(snapA.gatewayBridge.state, "connected");
    assert.equal(sharedSettings.size, 0, "Playground secrets must NEVER be persisted into visitor SQLite DB");

    const serializedSnap = JSON.stringify(snapA);
    assert.doesNotMatch(serializedSnap, /oc_secret_playground_gateway_token_999/);
    assert.doesNotMatch(serializedSnap, /cf_client_secret_super_private/);
    assert.doesNotMatch(serializedSnap, /cf_client_id_test\.access/);

    // 2. OPENCLAW_PLAYGROUND_LOCK=1 blocks SSRF settings changes, disconnect, rotate_pairing_code, exec approvals, and /pair even for role: 50!
    for (const blockedPayload of [
      {
        action: "configure_connection",
        gatewayUrl: "https://attacker-ssrf.example.com",
        allowGatewayExecApprovals: true,
      },
      {
        action: "save_settings",
        gatewayUrl: "https://attacker-ssrf.example.com",
      },
      { action: "disconnect" },
      { action: "rotate_pairing_code" },
      { action: "resolve_gateway_approval", approvalId: "appr_1", decision: "allow-once" },
    ]) {
      const res = await chat(
        createPlaygroundRouteCtx({
          role: 50,
          headers: { cookie: visitorACookie },
          sharedSettings,
          sharedKv,
          input: blockedPayload,
        }),
      );
      assert.equal(res.ok, false, `Expected ${blockedPayload.action} to be blocked in locked Playground`);
      assert.equal(res.error, "PLAYGROUND_LOCKED");
    }

    const pairBlocked = await pair(
      createPlaygroundRouteCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: { pairingCode: "oc_pair_anything", agentId: "rogue" },
      }),
    );
    assert.equal(pairBlocked.ok, false);
    assert.equal(pairBlocked.error, "PLAYGROUND_LOCKED");

    const blockKitSaveBlocked = await admin(
      createPlaygroundRouteCtx({
        role: 50,
        sharedSettings,
        sharedKv,
        input: {
          type: "form_submit",
          action_id: "save_connection",
          values: {
            gatewayUrl: "https://attacker.example.com",
            agentId: "rogue",
            gatewayToken: "tok",
          },
        },
      }),
    );
    assert.doesNotThrow(() => validateBlockResponse(blockKitSaveBlocked));
    assert.match(JSON.stringify(blockKitSaveBlocked), /locked in Playground mode/);
    assert.equal(sharedSettings.size, 0);

    // 3. Turn execution uses globalThis.fetch fallback, CF-Access headers, openclaw/<agentId>, x-openclaw-* headers, and hashed visitor sessionKey!
    const turnA = await chat(
      createPlaygroundRouteCtx({
        role: 50,
        headers: { cookie: visitorACookie },
        sharedSettings,
        sharedKv,
        includeCtxHttp: false,
        input: {
          action: "send_message",
          prompt: "Sharpen the Blobster Smith template tagline",
        },
      }),
    );
    assert.equal(outboundCalls.length, 1);
    const reqA = outboundCalls[0];
    assert.equal(reqA.url, "https://gateway-playground.example.test/v1/chat/completions");
    assert.equal(reqA.headers.Authorization, "Bearer oc_secret_playground_gateway_token_999");
    assert.equal(reqA.headers["x-openclaw-agent-id"], "blobster-smith");
    assert.equal(reqA.headers["x-openclaw-scopes"], "operator.write");
    assert.equal(reqA.headers["CF-Access-Client-Id"], "cf_client_id_test.access");
    assert.equal(reqA.headers["CF-Access-Client-Secret"], "cf_client_secret_super_private");
    assert.equal(reqA.body.model, "openclaw/blobster-smith");
    assert.equal(reqA.headers["x-openclaw-session-key"], reqA.body.user);
    assert.match(
      reqA.body.user,
      new RegExp(`^agent:blobster-smith:pg-${expectedHashA}:conv_`),
    );
    assert.equal(turnA.proposals.length, 1);

    // 4. Second anonymous Playground visitor with different cookie (or x-openclaw-playground-visitor header) gets an isolated sessionKey!
    const expectedHashB = crypto
      .createHash("sha256")
      .update("visitor_bravo_header_002")
      .digest("hex")
      .slice(0, 12);
    assert.notEqual(expectedHashA, expectedHashB);

    await chat(
      createPlaygroundRouteCtx({
        role: 50,
        headers: { "x-openclaw-playground-visitor": "visitor_bravo_header_002" },
        sharedSettings: new Map(),
        sharedKv: new Map(),
        includeCtxHttp: false,
        input: {
          action: "send_message",
          prompt: "Hello from Visitor B",
        },
      }),
    );
    assert.equal(outboundCalls.length, 2);
    const reqB = outboundCalls[1];
    assert.match(
      reqB.body.user,
      new RegExp(`^agent:blobster-smith:pg-${expectedHashB}:conv_`),
    );
    assert.notEqual(reqA.body.user, reqB.body.user);

    // 5. Also verify process.env fallback when globalThis.__openclawPlaygroundEnv is unset
    delete globalThis.__openclawPlaygroundEnv;
    process.env.OPENCLAW_PLAYGROUND_GATEWAY_URL = "http://127.0.0.1:19011";
    process.env.OPENCLAW_PLAYGROUND_GATEWAY_TOKEN = "oc_local_dev_tok";
    const localSnap = await chat(
      createPlaygroundRouteCtx({
        role: 50,
        sharedSettings: new Map(),
        sharedKv: new Map(),
        input: { action: "get_workspace" },
      }),
    );
    assert.equal(localSnap.paired, true);
    assert.equal(localSnap.connection.gatewayUrl, "http://127.0.0.1:19011");
    assert.equal(localSnap.connection.agentId, "blobster-smith");
    assert.equal(localSnap.playgroundLocked, false);
  } finally {
    globalThis.fetch = origFetch;
    clearPlaygroundEnv();
  }
});

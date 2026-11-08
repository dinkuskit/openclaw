import test from "node:test";
import assert from "node:assert/strict";
import { createPlugin, openclawNativePlugin } from "../dist/native.mjs";
import { openclawBridge } from "../dist/astro.mjs";
import { GET as streamGet } from "../dist/stream-endpoint.mjs";

function createStoreFixtures() {
  return {
    products: [
      {
        id: "prod_01",
        slug: "atelier-field-jacket",
        status: "published",
        version: 3,
        draftRevisionId: "rev_d3",
        data: {
          title: "Atelier Field Jacket",
          excerpt: "Waxed organic cotton jacket.",
          seoTitle: "Original SEO Title",
          priceCents: 18500,
        },
      },
    ],
    pages: [
      {
        id: "page_about",
        slug: "about",
        status: "published",
        version: 1,
        data: { title: "About Our Workshop", excerpt: "Small-batch craft." },
      },
    ],
  };
}

function createNativeRouteCtx({
  userId = "u_admin",
  role = 50,
  input = {},
  collections = [
    { slug: "products", label: "Products" },
    { slug: "pages", label: "Pages" },
  ],
  itemsByCollection = createStoreFixtures(),
  revisionsById = new Map(),
  sharedSettings = new Map(),
  sharedKv = new Map(),
} = {}) {
  let revCounter = 1;
  return {
    input,
    user: { id: userId, email: `${userId}@example.test`, name: userId, role },
    ui: { surface: "admin-page", locale: "en", direction: "ltr" },
    request: { url: "http://localhost:4321/_emdash/api/plugins/dinkus-openclaw/chat" },
    site: { url: "http://localhost:4321", name: "Atelier Store", locale: "en" },
    schema: {
      listCollections: async () => collections,
    },
    content: {
      list: async slug => ({ items: itemsByCollection[slug] ?? [] }),
      get: async (slug, id) => (itemsByCollection[slug] ?? []).find(i => i.id === id) ?? null,
      getRevision: async (_slug, _id, revisionId) => revisionsById.get(revisionId) ?? null,
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
    http: {
      fetch: async () => Response.json({ ok: true }),
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("native descriptor and createPlugin preserve dinkus-openclaw /openclaw URL and capabilities", () => {
  const descriptor = openclawNativePlugin();
  assert.equal(descriptor.id, "dinkus-openclaw");
  assert.equal(descriptor.format, "native");
  assert.equal(descriptor.adminPages?.[0]?.path, "/openclaw");

  const resolved = createPlugin();
  assert.equal(resolved.id, "dinkus-openclaw");
  assert.ok(resolved.routes.chat);
  assert.ok(resolved.routes.pair);
  assert.ok(!resolved.capabilities.includes("content:write"));
});

test("chat route enforces server-side receipt reconciliation, immutable revise_proposal, and draft-safe field guard", async () => {
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const itemsByCollection = createStoreFixtures();

  // 1. Refuse callers below Editor role (40)
  const denied = await chat(createNativeRouteCtx({ role: 20, input: { action: "get_workspace" } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "FORBIDDEN");

  // 2. Inspect live products collection
  const turn1 = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "send_message", prompt: "Can you see my products?" },
    }),
  );
  assert.equal(turn1.ok, true);
  const activeThread = turn1.threads.find(t => t.conversationId === turn1.activeConversationId);
  assert.equal(activeThread.messages.length, 2);
  assert.match(activeThread.messages[1].content, /Atelier Field Jacket/);
  assert.ok(activeThread.messages[1].toolCalls.some(tc => tc.name === "emdash.content.list"));

  // 3. Stage a revision-fenced draft proposal in propose_with_approval mode
  const turn2 = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "send_message",
        conversationId: turn1.activeConversationId,
        prompt:
          'Propose an updated excerpt for Atelier Field Jacket to "Weatherproof Japanese organic waxed canvas."',
      },
    }),
  );
  assert.equal(turn2.proposals.length, 1);
  const prop1 = turn2.proposals[0];
  assert.equal(prop1.revisionNumber, 1);
  assert.equal(prop1.status, "pending");

  // 4. Immutable Edit & Approve (`revise_proposal`) marks rev #1 superseded, mints rev #2, and strips SEO/status fields
  const revisedSnap = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "revise_proposal",
        conversationId: turn1.activeConversationId,
        proposalId: prop1.proposalId,
        proposedFields: {
          excerpt: "Hand-waxed organic cotton field jacket — batch #04.",
          seoTitle: "SHOULD_BE_STRIPPED",
          status: "published",
        },
      },
    }),
  );
  const rev2 = revisedSnap.proposals.find(p => p.proposalId === revisedSnap.revisedProposalId);
  const oldRev1 = revisedSnap.proposals.find(p => p.proposalId === prop1.proposalId);
  assert.ok(rev2);
  assert.equal(rev2.revisionNumber, 2);
  assert.equal(rev2.supersedesProposalId, prop1.proposalId);
  assert.equal(rev2.proposedFields.excerpt, "Hand-waxed organic cotton field jacket — batch #04.");
  assert.equal("seoTitle" in rev2.proposedFields, false);
  assert.equal("status" in rev2.proposedFields, false);
  assert.equal(oldRev1.status, "superseded");
  assert.equal(oldRev1.supersededByProposalId, rev2.proposalId);

  // 5. Anti-spoofing check: claiming `applied` BEFORE EmDash content actually changed downgrades to `outcome_unknown`
  const spoofAttempt = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "record_proposal_receipt",
        proposalId: rev2.proposalId,
        status: "applied",
        appliedRev: "emdash_rev_fake",
      },
    }),
  );
  const afterSpoof = spoofAttempt.proposals.find(p => p.proposalId === rev2.proposalId);
  assert.equal(afterSpoof.status, "outcome_unknown");

  // 6. Reconciling when CMS entry still has old text restores `pending` safely (no duplicate write!)
  const reconciledPending = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "reconcile_proposal",
        proposalId: rev2.proposalId,
      },
    }),
  );
  assert.equal(
    reconciledPending.proposals.find(p => p.proposalId === rev2.proposalId).status,
    "pending",
  );

  // 7. Simulate real EmDash PUT save updating stored entry, then record `applied` -> verified server-side!
  itemsByCollection.products[0].data.excerpt =
    "Hand-waxed organic cotton field jacket — batch #04.";
  const applied = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "record_proposal_receipt",
        proposalId: rev2.proposalId,
        status: "applied",
        appliedRev: "emdash_rev_opaque_v5",
      },
    }),
  );
  const verifiedProp = applied.proposals.find(p => p.proposalId === rev2.proposalId);
  assert.equal(verifiedProp.status, "applied");
  assert.equal(verifiedProp.reconciledServerSide, true);
  assert.equal(verifiedProp.appliedRev, "emdash_rev_opaque_v5");
});

test("per-user personal threads & SSE audience isolation prevent cross-editor leakage until explicitly shared", async () => {
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();

  // Editor u_alice starts a personal conversation
  const aliceTurn = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      input: { action: "send_message", prompt: "Can you see my products?" },
    }),
  );
  const aliceConvId = aliceTurn.activeConversationId;
  assert.equal(aliceTurn.threads[0].visibility, "personal");

  // Editor u_bob does NOT see u_alice's personal conversation
  const bobSnap1 = await chat(
    createNativeRouteCtx({
      userId: "u_bob",
      role: 40,
      sharedSettings,
      sharedKv,
      input: { action: "get_workspace" },
    }),
  );
  assert.equal(
    bobSnap1.threads.some(t => t.conversationId === aliceConvId),
    false,
  );

  // Connect SSE streams for both u_alice and u_bob
  const aliceAbort = new AbortController();
  const bobAbort = new AbortController();
  const aliceStream = await streamGet({
    request: new Request("http://localhost:4321/_emdash/api/openclaw/stream", {
      signal: aliceAbort.signal,
    }),
    url: new URL("http://localhost:4321/_emdash/api/openclaw/stream"),
    locals: { user: { id: "u_alice", role: 40 } },
  });
  const bobStream = await streamGet({
    request: new Request("http://localhost:4321/_emdash/api/openclaw/stream", {
      signal: bobAbort.signal,
    }),
    url: new URL("http://localhost:4321/_emdash/api/openclaw/stream"),
    locals: { user: { id: "u_bob", role: 40 } },
  });

  const aliceReader = aliceStream.body.getReader();
  const bobReader = bobStream.body.getReader();
  const decoder = new TextDecoder();

  // Consume initial `connected` frames
  assert.match(decoder.decode((await aliceReader.read()).value), /"type":"connected"/);
  assert.match(decoder.decode((await bobReader.read()).value), /"type":"connected"/);

  // Trigger a personal turn for u_alice; u_alice receives it immediately!
  await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      input: {
        action: "send_message",
        conversationId: aliceConvId,
        prompt: "Private draft check for Alice",
      },
    }),
  );
  const aliceEvent = await aliceReader.read();
  assert.match(decoder.decode(aliceEvent.value), /"conversationId"/);

  // Now u_alice shares the thread with the store team (`toggle_thread_visibility`)
  const sharedSnap = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      input: { action: "toggle_thread_visibility", conversationId: aliceConvId },
    }),
  );
  assert.equal(
    sharedSnap.threads.find(t => t.conversationId === aliceConvId).visibility,
    "shared",
  );

  const bobSnap2 = await chat(
    createNativeRouteCtx({
      userId: "u_bob",
      role: 40,
      sharedSettings,
      sharedKv,
      input: { action: "get_workspace" },
    }),
  );
  assert.equal(
    bobSnap2.threads.some(t => t.conversationId === aliceConvId),
    true,
  );

  aliceAbort.abort();
  bobAbort.abort();
});

test("published entries with staged draft revisions reconcile via content:revisions:read without mutating live data", async () => {
  const resolved = createPlugin();
  assert.ok(resolved.capabilities.includes("content:revisions:read"));
  assert.ok(!resolved.capabilities.includes("content:write"));

  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const revisionsById = new Map();
  const itemsByCollection = {
    products: [
      {
        id: "prod_beanie",
        slug: "ribbed-beanie",
        status: "published",
        version: 4,
        liveRevisionId: "rev_live_4",
        draftRevisionId: "rev_live_4",
        data: {
          title: "Ribbed Beanie",
          description: "A soft, close-fitting cold-weather staple.",
        },
      },
    ],
  };

  const turn = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      revisionsById,
      itemsByCollection,
      input: {
        action: "send_message",
        prompt:
          'Update description on Ribbed Beanie to "Merino-ribbed cold-weather beanie — knit in small batches."',
      },
    }),
  );
  const prop = turn.proposals[0];
  assert.equal(prop.status, "pending");

  // Spoofed `applied` before draft revision exists is caught and downgraded to `outcome_unknown`
  const spoofed = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      revisionsById,
      itemsByCollection,
      input: {
        action: "record_proposal_receipt",
        proposalId: prop.proposalId,
        status: "applied",
        appliedRev: "rev_fake",
      },
    }),
  );
  assert.equal(spoofed.proposals[0].status, "outcome_unknown");

  // Simulate EmDash PUT saving a draft revision on a published entry (`data` stays live, `draftRevisionId` advances)
  itemsByCollection.products[0].draftRevisionId = "rev_draft_5";
  itemsByCollection.products[0].version = 5;
  revisionsById.set("rev_draft_5", {
    id: "rev_draft_5",
    collection: "products",
    entryId: "prod_beanie",
    data: {
      title: "Ribbed Beanie",
      description: "Merino-ribbed cold-weather beanie — knit in small batches.",
    },
  });

  const reconciled = await chat(
    createNativeRouteCtx({
      sharedSettings,
      sharedKv,
      revisionsById,
      itemsByCollection,
      input: {
        action: "reconcile_proposal",
        proposalId: prop.proposalId,
      },
    }),
  );
  assert.equal(reconciled.proposals[0].status, "applied");
  assert.equal(reconciled.proposals[0].reconciledServerSide, true);
});

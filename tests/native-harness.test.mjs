import test from "node:test";
import assert from "node:assert/strict";
import { createPlugin, openclawNativePlugin } from "../dist/native.mjs";
import { openclawBridge } from "../dist/astro.mjs";
import { GET as streamGet } from "../dist/stream-endpoint.mjs";
import pluginSandbox from "../dist/plugin.mjs";
import {
  applyRevisionProposal,
  connectOpenClawEventStream,
  fetchLiveEntryWithRev,
  reconcileUnknownProposal,
} from "../.tmp/solid-build/emdash-client.mjs";

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

test("enforces admin-only pairing codes, private proposal SSE, base-rev conflict guard, and concurrent turn merge", async () => {
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const itemsByCollection = createStoreFixtures();

  // 1. Non-admin Editor never mints or receives pairing codes
  const editorSnap = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "get_workspace" },
    }),
  );
  assert.equal(editorSnap.pairingCode, "");
  assert.equal(editorSnap.pairingCommand, "");
  assert.equal(sharedKv.has("pairing_code"), false);

  // Admin configures propose_with_approval connection (and mints pairing code)
  const adminSnap = await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "configure_connection",
        gatewayUrl: "https://agent-session.openclaw.local",
        authorityMode: "propose_with_approval",
      },
    }),
  );
  assert.ok(adminSnap.pairingCode.startsWith("oc_pair_"));

  // 2. Private proposal updates stay isolated to u_alice on SSE & route auth
  const aliceTurn = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "send_message",
        conversationId: editorSnap.activeConversationId,
        prompt: 'Propose an updated excerpt for Atelier Field Jacket to "Private Alice Draft."',
      },
    }),
  );
  const aliceProp = aliceTurn.proposals[0];
  assert.ok(aliceProp);

  const bobDenied = await chat(
    createNativeRouteCtx({
      userId: "u_bob",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "revise_proposal",
        proposalId: aliceProp.proposalId,
        proposedFields: { excerpt: "Bob Tamper" },
      },
    }),
  );
  assert.equal(bobDenied.ok, false);
  assert.equal(bobDenied.error, "FORBIDDEN");

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

  const revisedSnap = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "revise_proposal",
        conversationId: editorSnap.activeConversationId,
        proposalId: aliceProp.proposalId,
        proposedFields: { excerpt: "Private Alice Rev 2" },
      },
    }),
  );
  const aliceRev2 = revisedSnap.proposals.find(p => p.revisionNumber === 2);
  assert.ok(aliceRev2);

  // Trigger a shared event afterwards; u_bob must receive ONLY the shared event, never Alice's proposal_updated!
  await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "configure_connection", gatewayUrl: "https://agent-session.openclaw.local" },
    }),
  );
  const bobFrame1 = decoder.decode((await bobReader.read()).value);
  const bobFrame2 = bobFrame1.includes('"reason":"connection_updated"')
    ? ""
    : decoder.decode((await bobReader.read()).value);
  const bobCombined = bobFrame1 + bobFrame2;
  assert.doesNotMatch(bobCombined, /Private Alice Rev 2/);
  assert.doesNotMatch(bobCombined, /"type":"proposal_updated"/);
  assert.match(bobCombined, /"reason":"connection_updated"/);
  bobAbort.abort();

  // 3. Concurrent entry modification before stamp_proposal_rev transitions proposal to conflict instead of stamping newer _rev
  itemsByCollection.products[0].version = 4;
  itemsByCollection.products[0].data.excerpt = "Intervening editor edit";
  const conflictSnap = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "stamp_proposal_rev",
        conversationId: editorSnap.activeConversationId,
        proposalId: aliceRev2.proposalId,
        baseRev: "opaque_rev_v4",
      },
    }),
  );
  const conflicted = conflictSnap.proposals.find(p => p.proposalId === aliceRev2.proposalId);
  assert.equal(conflicted.status, "conflict");
  assert.equal(conflicted.conflictRev, "opaque_rev_v4");

  const rebasedSnap = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "rebase_proposal",
        conversationId: editorSnap.activeConversationId,
        proposalId: aliceRev2.proposalId,
        baseRev: "opaque_rev_v4",
      },
    }),
  );
  const rebased = rebasedSnap.proposals.find(p => p.proposalId === aliceRev2.proposalId);
  assert.equal(rebased.status, "pending");
  assert.equal(rebased.baseRev, "opaque_rev_v4");
  assert.equal(rebased.diffs[0].before, "Intervening editor edit");

  // 4. Concurrent thread edits during an in-flight turn are preserved on turn completion
  let releaseTurn;
  const slowTurnPromise = new Promise(resolve => {
    releaseTurn = resolve;
  });
  const baseCtx = createNativeRouteCtx({
    userId: "u_alice",
    role: 40,
    sharedSettings,
    sharedKv,
    itemsByCollection,
    input: {
      action: "send_message",
      conversationId: editorSnap.activeConversationId,
      prompt: "Show me my products",
    },
  });
  const origList = baseCtx.content.list;
  baseCtx.content.list = async slug => {
    await slowTurnPromise;
    return origList(slug);
  };

  const inFlightTurn = chat(baseCtx);
  await new Promise(r => setTimeout(r, 25));

  const createdWhileRunning = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "create_thread", title: "Mid-Run Sibling Thread" },
    }),
  );
  assert.ok(createdWhileRunning.threads.some(t => t.title === "Mid-Run Sibling Thread"));

  releaseTurn();
  const completedTurn = await inFlightTurn;
  assert.ok(completedTurn.threads.some(t => t.title === "Mid-Run Sibling Thread"));
  const finalAliceThread = completedTurn.threads.find(
    t => t.conversationId === editorSnap.activeConversationId,
  );
  assert.ok(finalAliceThread.messages.some(m => /Atelier Field Jacket/.test(m.content)));
});

test("browser emdash-client preserves /compare staged drafts, enforces revision capabilities, blocks stale-tab applies, and reconciles interrupted saves", async () => {
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const itemsByCollection = createStoreFixtures();
  itemsByCollection.banners = [
    {
      id: "ban_01",
      slug: "summer-banner",
      status: "published",
      version: 1,
      data: { title: "Summer Sale", excerpt: "Live banner text" },
    },
  ];
  const collections = [
    { slug: "products", label: "Products", supports: ["drafts", "revisions"] },
    { slug: "banners", label: "Banners", supports: ["drafts"] },
  ];

  // EmDash 1.4.0: GET /content/products/prod_01 returns live fields while /compare returns staged draft
  itemsByCollection.products[0].liveRevisionId = "rev_live_1";
  itemsByCollection.products[0].draftRevisionId = "rev_draft_2";
  let stagedDraft = {
    title: "Unpublished Staged Jacket Title",
    excerpt: "Waxed organic cotton jacket.",
    _internalMeta: "strip_me",
  };
  const putPayloads = [];
  let activeTabUser = "u_admin";

  const makeEmDash140Ctx = input => {
    const ctx = createNativeRouteCtx({
      userId: activeTabUser,
      role: 50,
      sharedSettings,
      sharedKv,
      collections,
      itemsByCollection,
      input,
    });
    // Simulate EmDash 1.4.0 plugin runtime where ctx.content.getRevision is absent
    delete ctx.content.getRevision;
    return ctx;
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (urlRaw, init = {}) => {
    const url = String(urlRaw);
    const method = (init.method ?? "GET").toUpperCase();

    if (url.endsWith("/_emdash/api/plugins/dinkus-openclaw/chat")) {
      const body = JSON.parse(String(init.body ?? "{}"));
      const data = await chat(makeEmDash140Ctx(body));
      return Response.json({ success: true, data });
    }

    const schemaMatch = url.match(/\/_emdash\/api\/schema\/collections\/([^?]+)/);
    if (schemaMatch && method === "GET") {
      const slug = decodeURIComponent(schemaMatch[1]);
      const col = collections.find(c => c.slug === slug);
      return Response.json({
        success: true,
        data: { item: { slug, supports: col?.supports ?? [] } },
      });
    }

    const compareMatch = url.match(/\/_emdash\/api\/content\/([^/]+)\/([^/?]+)\/compare/);
    if (compareMatch && method === "GET") {
      return Response.json({
        success: true,
        data: { hasChanges: true, draft: stagedDraft },
      });
    }

    const contentMatch = url.match(/\/_emdash\/api\/content\/([^/]+)\/([^/?]+)/);
    if (contentMatch && method === "GET") {
      const [, colSlug, id] = contentMatch;
      const item = (itemsByCollection[colSlug] ?? []).find(i => i.id === id);
      return Response.json({
        success: true,
        data: { item: structuredClone(item), _rev: `opaque_${colSlug}_${item.version}` },
      });
    }

    if (contentMatch && method === "PUT") {
      const [, colSlug, id] = contentMatch;
      const parsed = JSON.parse(String(init.body ?? "{}"));
      putPayloads.push({ colSlug, id, parsed });
      stagedDraft = { ...parsed.data };
      const item = (itemsByCollection[colSlug] ?? []).find(i => i.id === id);
      item.version += 1;
      item.draftRevisionId = `rev_draft_${item.version}`;
      return Response.json({
        success: true,
        data: { item, _rev: `opaque_${colSlug}_${item.version}` },
      });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };

  try {
    // 1. Apply proposal on published entry with existing staged draft: /compare draft fields MUST be preserved!
    const turn = await chat(
      makeEmDash140Ctx({
        action: "send_message",
        prompt: 'Propose an updated excerpt for Atelier Field Jacket to "Preserved Draft Excerpt"',
      }),
    );
    const prop = turn.proposals[0];
    assert.ok(prop);

    const fetched = await fetchLiveEntryWithRev("products", "prod_01");
    assert.equal(fetched.item.data.title, "Unpublished Staged Jacket Title");
    assert.equal("_internalMeta" in fetched.item.data, false);

    const appliedSnap = await applyRevisionProposal(prop);
    assert.equal(putPayloads.length, 1);
    assert.equal(
      putPayloads[0].parsed.data.title,
      "Unpublished Staged Jacket Title",
      "Existing staged draft title must not be overwritten with older live title",
    );
    assert.equal(putPayloads[0].parsed.data.excerpt, "Preserved Draft Excerpt");
    assert.equal(
      appliedSnap.proposals.find(p => p.proposalId === prop.proposalId)?.status,
      "applied",
    );

    // 2. Collection WITHOUT `revisions` on a published entry MUST NOT send PUT to live content!
    const bannerProposal = {
      proposalId: "prop_banner_live_1",
      revisionNumber: 1,
      conversationId: turn.activeConversationId,
      agentId: "openclaw",
      collection: "banners",
      entryId: "ban_01",
      entrySlug: "summer-banner",
      entryTitle: "Summer Sale",
      baseRev: "opaque_banners_1",
      summary: "Attempt draft save on non-revision collection",
      targetTool: "content:update",
      proposedFields: { excerpt: "Would mutate live!" },
      diffs: [
        {
          field: "excerpt",
          label: "excerpt",
          before: "Live banner text",
          after: "Would mutate live!",
          addedLines: 1,
          removedLines: 1,
        },
      ],
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    sharedKv.set("revision_proposals_v2", [
      bannerProposal,
      ...(sharedKv.get("revision_proposals_v2") ?? []),
    ]);

    const serverBlocked = await chat(
      makeEmDash140Ctx({
        action: "begin_apply_proposal",
        conversationId: turn.activeConversationId,
        proposalId: "prop_banner_live_1",
        expectedRev: "opaque_banners_1",
      }),
    );
    assert.equal(serverBlocked.ok, false);
    assert.equal(serverBlocked.error, "REVISIONS_NOT_SUPPORTED");

    const clientBlockedSnap = await applyRevisionProposal(bannerProposal);
    assert.equal(putPayloads.length, 1, "PUT must never be called for non-revision published entry");
    const failedBanner = clientBlockedSnap.proposals.find(
      p => p.proposalId === "prop_banner_live_1",
    );
    assert.equal(failedBanner.status, "failed");

    // 3. Stale tab cannot apply a proposal that was already rejected or superseded in another tab!
    const staleProposal = {
      ...bannerProposal,
      proposalId: "prop_stale_tab_1",
      collection: "products",
      entryId: "prod_01",
      entrySlug: "atelier-field-jacket",
      entryTitle: "Unpublished Staged Jacket Title",
      baseRev: `opaque_products_${itemsByCollection.products[0].version}`,
      proposedFields: { excerpt: "Stale tab write" },
      diffs: [
        {
          field: "excerpt",
          label: "excerpt",
          before: "Waxed organic cotton jacket.",
          after: "Stale tab write",
          addedLines: 1,
          removedLines: 1,
        },
      ],
      status: "pending",
    };
    sharedKv.set("revision_proposals_v2", [
      staleProposal,
      ...(sharedKv.get("revision_proposals_v2") ?? []),
    ]);

    // Tab 1 rejects it
    await chat(
      makeEmDash140Ctx({
        action: "record_proposal_receipt",
        conversationId: turn.activeConversationId,
        proposalId: "prop_stale_tab_1",
        status: "rejected",
      }),
    );

    // Tab 2 still holds `staleProposal` (`status: "pending"`) and tries to apply or Edit & Approve
    await assert.rejects(
      () => applyRevisionProposal(staleProposal),
      /status is "rejected"/,
    );
    await assert.rejects(
      () => applyRevisionProposal(staleProposal, { excerpt: "Stale revised write" }),
      /status is "rejected"/,
    );
    assert.equal(putPayloads.length, 1, "Stale tab must never dispatch PUT");

    // 4. Interrupted `applying` save on EmDash 1.4.0 published draft reconciles via /compare!
    const interruptedProp = {
      ...staleProposal,
      proposalId: "prop_interrupted_1",
      proposedFields: { excerpt: "Preserved Draft Excerpt" },
      status: "applying",
    };
    sharedKv.set("revision_proposals_v2", [
      interruptedProp,
      ...(sharedKv.get("revision_proposals_v2") ?? []),
    ]);
    const reconciledSnap = await reconcileUnknownProposal(interruptedProp);
    const reconciledItem = reconciledSnap.proposals.find(
      p => p.proposalId === "prop_interrupted_1",
    );
    assert.equal(reconciledItem.status, "applied");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("shared->personal toggle mid-setup isolates SSE, 65+ threads keep new user turns, concurrent /pair imports survive, and credential read errors stay non-destructive", async () => {
  const resolved = createPlugin();
  const chat = resolved.routes.chat.handler;
  const sharedSettings = new Map();
  const sharedKv = new Map();
  const itemsByCollection = createStoreFixtures();

  // 1. Non-destructive credential read handling on `settings.get` failure
  await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "configure_connection",
        gatewayUrl: "wss://gw.example.com",
        gatewayToken: "secret_preserved_tok",
        agentId: "roboclaw",
      },
    }),
  );
  assert.ok(sharedSettings.has("connection"));

  const brokenSettingsCtx = input => {
    const ctx = createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input,
    });
    ctx.settings.get = async () => {
      throw new Error("Decryption key unavailable");
    };
    return ctx;
  };

  const snapDuringOutage = await chat(brokenSettingsCtx({ action: "get_workspace" }));
  assert.ok(snapDuringOutage.settingsError);
  assert.ok(sharedSettings.has("connection"), "get_workspace must not delete encrypted settings");

  const brokenAdminCtx = brokenSettingsCtx({ type: "page_load" });
  await pluginSandbox.routes.admin.handler(brokenAdminCtx, brokenAdminCtx);
  assert.ok(sharedSettings.has("connection"), "admin Block Kit route must not delete encrypted settings");

  const partialSaveBlocked = await chat(
    brokenSettingsCtx({ action: "configure_connection", authorityMode: "read_only" }),
  );
  assert.equal(partialSaveBlocked.ok, false);
  assert.equal(partialSaveBlocked.error, "SETTINGS_READ_ERROR");
  assert.match(sharedSettings.get("connection").value, /secret_preserved_tok/);

  // 1b. HTTPS completion endpoints stay `https://` (`live-gateway`) across unrelated settings updates,
  //     and legacy stored URL userinfo is never exposed to Editors!
  const httpsSaved = await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "configure_connection",
        gatewayUrl: "https://completions.example.com/v1/chat/completions",
        gatewayToken: "http_bearer_tok",
        agentId: "roboclaw",
        authorityMode: "read_only",
      },
    }),
  );
  assert.equal(httpsSaved.connection.gatewayUrl, "https://completions.example.com/v1/chat/completions");
  assert.equal(httpsSaved.connection.transportMode, "live-gateway");

  const httpsAfterAuthorityToggle = await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "configure_connection",
        authorityMode: "propose_with_approval",
      },
    }),
  );
  assert.equal(
    httpsAfterAuthorityToggle.connection.gatewayUrl,
    "https://completions.example.com/v1/chat/completions",
    "Toggling authorityMode must not convert an HTTPS completion endpoint into wss://",
  );
  assert.equal(httpsAfterAuthorityToggle.connection.transportMode, "live-gateway");

  // Simulate legacy pre-existing stored URL containing userinfo + query token and verify Editor snapshot scrubs it
  sharedSettings.set("connection", {
    revision: "99",
    value: JSON.stringify({
      gatewayUrl: "https://legacy_user:legacy_secret@completions.example.com/v1/chat/completions?token=secret_q",
      agentId: "roboclaw",
      gatewayToken: "http_bearer_tok",
      authorityMode: "propose_with_approval",
      enabledCollections: ["products", "pages"],
    }),
  });
  const editorScrubbedSnap = await chat(
    createNativeRouteCtx({
      userId: "u_editor",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "get_workspace" },
    }),
  );
  assert.equal(
    editorScrubbedSnap.connection.gatewayUrl,
    "https://completions.example.com/v1/chat/completions",
    "Editor workspace snapshot must strip URL userinfo and token query params",
  );

  // Reset to local inspector mode for turn tests
  await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: {
        action: "configure_connection",
        gatewayUrl: "https://agent-session.openclaw.local",
        gatewayToken: "local_tok",
        authorityMode: "propose_with_approval",
      },
    }),
  );

  // 2. Making a shared conversation personal while content reads are in flight must NOT leak tool_call or assistant_delta to u_bob!
  const createdShared = await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "create_thread", title: "Shared Then Private", visibility: "shared" },
    }),
  );
  const sharedConvId = createdShared.activeConversationId;

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

  let releaseList;
  const pauseList = new Promise(r => {
    releaseList = r;
  });
  const aliceSlowSendCtx = createNativeRouteCtx({
    userId: "u_alice",
    role: 40,
    sharedSettings,
    sharedKv,
    itemsByCollection,
    input: {
      action: "send_message",
      conversationId: sharedConvId,
      prompt: "Inspect products confidentially",
    },
  });
  const origList = aliceSlowSendCtx.content.list;
  aliceSlowSendCtx.content.list = async slug => {
    await pauseList;
    return origList(slug);
  };

  const inFlightSend = chat(aliceSlowSendCtx);
  // Read turn_started (emitted while still shared)
  const turnStartFrame = decoder.decode((await bobReader.read()).value);
  assert.match(turnStartFrame, /"type":"turn_started"/);

  // Now Alice switches the thread to personal BEFORE content.list finishes!
  await chat(
    createNativeRouteCtx({
      userId: "u_alice",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "toggle_thread_visibility", conversationId: sharedConvId },
    }),
  );

  releaseList();
  await inFlightSend;

  // Emit a known shared marker so we can read Bob's next frame deterministically without hanging
  await chat(
    createNativeRouteCtx({
      userId: "u_admin",
      role: 50,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "configure_connection", gatewayUrl: "https://agent-session.openclaw.local" },
    }),
  );
  let bobNextCombined = "";
  while (!bobNextCombined.includes('"reason":"connection_updated"')) {
    bobNextCombined += decoder.decode((await bobReader.read()).value);
  }
  assert.doesNotMatch(bobNextCombined, /"type":"tool_call"/);
  assert.doesNotMatch(bobNextCombined, /"type":"assistant_delta"/);
  assert.match(bobNextCombined, /"reason":"connection_updated"/);
  bobAbort.abort();

  // 3. Store capacity: 65 existing personal threads from other users must NOT drop a new user's initialized thread or message!
  const crowdedThreads = Array.from({ length: 65 }, (_, i) => ({
    conversationId: `conv_crowded_${i}`,
    ownerUserId: `u_crowd_${i}`,
    visibility: "personal",
    title: `Crowded ${i}`,
    scopeGroup: "products",
    status: "idle",
    createdAt: new Date(Date.now() + 10_000).toISOString(),
    updatedAt: new Date(Date.now() + 10_000).toISOString(),
    messages: [],
  }));
  sharedKv.set("chat_threads_v2", crowdedThreads);

  const newEditorTurn = await chat(
    createNativeRouteCtx({
      userId: "u_latecomer",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "send_message", prompt: "Can you see my products?" },
    }),
  );
  const latecomerConvId = newEditorTurn.activeConversationId;
  const reloadedLatecomer = await chat(
    createNativeRouteCtx({
      userId: "u_latecomer",
      role: 40,
      sharedSettings,
      sharedKv,
      itemsByCollection,
      input: { action: "get_workspace", conversationId: latecomerConvId },
    }),
  );
  const persistedLatecomerThread = reloadedLatecomer.threads.find(
    t => t.conversationId === latecomerConvId,
  );
  assert.ok(persistedLatecomerThread, "New user's thread must survive store retention cap");
  assert.equal(persistedLatecomerThread.messages.length, 2);

  // 4. Concurrent external proposal arriving in `pending_proposals` while `loadRevisionProposals` is awaiting `content.get` must NOT be deleted!
  sharedKv.set("pending_proposals", [
    {
      proposalId: "prop_race_first",
      collection: "products",
      entryId: "prod_01",
      summary: "First external proposal",
      proposedFields: { excerpt: "First external copy" },
    },
  ]);

  let releaseGet;
  const pauseGet = new Promise(r => {
    releaseGet = r;
  });
  const slowLoadCtx = createNativeRouteCtx({
    userId: "u_admin",
    role: 50,
    sharedSettings,
    sharedKv,
    itemsByCollection,
    input: { action: "get_workspace" },
  });
  const origGet = slowLoadCtx.content.get;
  let pausedOnce = false;
  slowLoadCtx.content.get = async (slug, id) => {
    if (!pausedOnce) {
      pausedOnce = true;
      await pauseGet;
    }
    return origGet(slug, id);
  };

  const loadingSnapPromise = chat(slowLoadCtx);
  await new Promise(r => setTimeout(r, 20));

  // Concurrent external arrival appends `prop_race_second` while `prop_race_first` is mid-hydration
  const currentPending = sharedKv.get("pending_proposals") ?? [];
  sharedKv.set("pending_proposals", [
    ...currentPending,
    {
      proposalId: "prop_race_second",
      collection: "products",
      entryId: "prod_01",
      summary: "Second concurrent external proposal",
      proposedFields: { excerpt: "Second external copy" },
    },
  ]);

  releaseGet();
  const afterRaceSnap = await loadingSnapPromise;
  assert.ok(afterRaceSnap.proposals.some(p => p.proposalId === "prop_race_first"));
  assert.ok(
    afterRaceSnap.proposals.some(p => p.proposalId === "prop_race_second"),
    "Concurrent external proposal arriving during hydration must not be deleted",
  );

  // 5. Event stream client invokes `onReconnect` after stream drop
  const origStreamFetch = globalThis.fetch;
  let connectCalls = 0;
  let reconnectNotifications = 0;
  globalThis.fetch = async () => {
    connectCalls += 1;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const stop = connectOpenClawEventStream({
      endpoint: "http://localhost:4321/_emdash/api/openclaw/stream",
      onEvent() {},
      onStatus() {},
      onReconnect() {
        reconnectNotifications += 1;
      },
    });
    await new Promise(r => setTimeout(r, 950));
    stop();
    assert.ok(connectCalls >= 2);
    assert.ok(reconnectNotifications >= 1, "onReconnect must fire when SSE reconnects");
  } finally {
    globalThis.fetch = origStreamFetch;
  }
});

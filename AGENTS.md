# Agent Contract

This public repository owns `@dinkuskit/openclaw` (`dinkus-openclaw`), the
open-source EmDash plugin that connects an OpenClaw gateway and custom agents to
the EmDash CMS admin across two mutually exclusive installation profiles sharing
the `dinkus-openclaw` product identity. Assume every committed byte is
immediately public.

## Source priority

1. This file.
2. `docs/CHARTER.md` (once grilled and locked).
3. `.grilltrack/ledger.json`, maintained only through the GrillTrack CLI.
4. Current source, tests, and committed proof.

## Public-safe boundary

- Never commit credentials, gateway tokens, environment files, customer or
  tenant data, private Tailscale/SSH hostnames, private repository coordinates,
  or private operating rationale.
- This repository has an independent Git root. Never merge, cherry-pick,
  subtree, fork, bundle, or otherwise import unrelated repository history.

## Architectural invariants

- **Dual installation profiles, single URL (`/_emdash/admin/plugins/dinkus-openclaw/openclaw`):**
  - **Sandboxed Registry profile (`@dinkuskit/openclaw` + `./sandbox`):** Admin
    UI is Block Kit only (`@emdash-cms/blocks/server`). Measure the built
    `backend.js` against the `128 KiB` Registry per-file cap
    (`scripts/check-registry-bundle.mjs`).
  - **Native Interactive Harness (`@dinkuskit/openclaw/native` + `./admin` + `./astro`):**
    Mounts thin React host adapters (`pages["/openclaw"]` and
    `contentEditorPanels`) hosting one precompiled SolidJS Web Component
    (`<openclaw-emdash-chat>`) backed by an authenticated host Astro SSE bridge
    (`/_emdash/api/openclaw/stream`).
- **Gateway owns conversation execution; EmDash owns CMS mutations:** The plugin
  declares `schema:read`, `content:read` (plus `content:revisions:read` in the
  native profile to reconcile staged drafts on published entries), and
  `network:request:unrestricted` only (never `content:write`). Approved draft
  proposals execute through EmDash's authenticated revision-fenced content API
  (`_rev` optimistic concurrency:
  `pending -> applying -> applied | conflict | outcome_unknown | failed`).
- **No plugin-to-plugin imports in the sandbox:** Companion DinkusKit plugins
  (`Commerce`, `Payments`, `Ship`) interact through EmDash's permissioned MCP
  and capability-gated host APIs.
- **Read-only start & human approval cards:** Mutations require explicit
  `propose_with_approval` authority and human approval cards.

## Bootstrap state and gates

- Public scaffold (`0.0.0`, `"private": true`). Keep out of the DinkusKit v1
  store launch critical path (`Commerce`, `Payments`, `Ship`).
- Run `bin/verify-openclaw quick` before every commit.
- Do not publish to npm, list in an EmDash marketplace or registry, deploy,
  merge, or mutate a production site without explicit owner approval.

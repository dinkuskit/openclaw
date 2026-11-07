# Agent Contract

This public repository owns `@dinkuskit/openclaw` (`dinkus-openclaw`), the
open-source EmDash plugin that connects an OpenClaw gateway and custom agents to
the EmDash CMS admin with Block Kit approval cards and MCP tools. Assume every
committed byte is immediately public.

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

- **Sandboxed Registry plugin (`dinkus-openclaw`):** Admin UI is Block Kit only
  (`@emdash-cms/blocks/server`). Measure the built `backend.js` against the
  `128 KiB` Registry per-file cap (`scripts/check-registry-bundle.mjs`).
- **No plugin-to-plugin imports in the sandbox:** OpenClaw agents interact with
  EmDash content, drafts, and companion DinkusKit plugins (`Commerce`,
  `Payments`, `Ship`) through EmDash's native permissioned MCP server and
  capability-gated host APIs (`schema:read`, `content:read`,
  `admin.editor-draft:read`, `admin.editor-draft:patch`).
- **Read-only start & `WAITING_FOR_HUMAN` approval cards:** Assistant access
  starts read-only by default. Mutations require explicit per-business authority
  and human approval cards.

## Bootstrap state and gates

- Public scaffold (`0.0.0`, `"private": true`). Keep out of the DinkusKit v1
  store launch critical path (`Commerce`, `Payments`, `Ship`).
- Run `bin/verify-openclaw quick` before every commit.
- Do not publish to npm, list in an EmDash marketplace or registry, deploy,
  merge, or mutate a production site without explicit owner approval.

# @dinkuskit/openclaw

<p align="center">
  <img alt="@dinkuskit/openclaw — Connect custom OpenClaw agents & gateways to EmDash CMS and DinkusKit stores" src=".github/assets/dinkusclaw-readme-banner-16x9.jpg" width="100%">
</p>

<p align="center">
  <a href="https://github.com/dinkuskit/openclaw/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dinkuskit/openclaw/ci.yml?branch=main&style=flat-square&label=CI" alt="CI Status"></a>
  <a href="https://www.npmjs.com/package/@dinkuskit/openclaw"><img src="https://img.shields.io/badge/npm-%40dinkuskit%2Fopenclaw-orange?style=flat-square" alt="npm package"></a>
  <a href="https://github.com/openclaw/openclaw"><img src="https://img.shields.io/badge/gateway-protocol%20v4-blue?style=flat-square" alt="Gateway Protocol v4"></a>
  <a href="https://github.com/emdash-cms/emdash"><img src="https://img.shields.io/badge/emdash-%3E%3D%201.4.0-success?style=flat-square" alt="EmDash Compatibility"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License MIT"></a>
</p>

<p align="center">
  <a href="#installation-profiles">Profiles</a> &middot;
  <a href="#agent-templates--custom-harnesses-agents-template">Agent Templates</a> &middot;
  <a href="#architecture--system-flow">Architecture</a> &middot;
  <a href="#security--authority-model">Security &amp; Authority</a> &middot;
  <a href="docs/design/dinkusclaw-character-and-pet-rig.md">DinkusClaw Spec</a> &middot;
  <a href="#verification">Verification</a>
</p>

`* * *`

Connect custom [OpenClaw](https://github.com/openclaw) agents and gateways to [EmDash CMS](https://github.com/emdash-cms/emdash) and [DinkusKit](https://github.com/dinkuskit) stores (`dinkus-openclaw`).

> **Gateway owns conversation execution. EmDash owns CMS mutations. The bridge connects them; the UI projects their state.**

---

## Architecture & System Flow

```
 ┌────────────────────────────────────────────────────────┐
 │            External OpenClaw Gateway Host              │
 │  - Protocol v4 WebSocket (@openclaw/gateway-client)    │
 │  - Autonomous Execution & Agent Workspaces             │
 └───────────────────────────┬────────────────────────────┘
                             │ loopback ws:// or TLS wss://
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │           @dinkuskit/openclaw Server Bridge            │
 │  - Server-side Ed25519 device authentication           │
 │  - Astro authenticated SSE stream endpoint             │
 │  - Dual-authority draft & execution gatekeeper         │
 └─────────────┬────────────────────────────┬─────────────┘
               │ Native Profile             │ Sandbox Profile
               ▼                            ▼
 ┌───────────────────────────┐ ┌──────────────────────────┐
 │    In-Process React Admin │ │  Sandboxed Registry      │
 │  <openclaw-emdash-chat>   │ │  Declarative Block Kit   │
 │  Live delta streaming     │ │  < 128 KiB backend.js    │
 └───────────────────────────┘ └──────────────────────────┘
```

---

## Installation Profiles

`@dinkuskit/openclaw` ships two mutually exclusive installation profiles sharing the `dinkus-openclaw` product identity so both mount cleanly at `/_emdash/admin/plugins/dinkus-openclaw/openclaw` and in saved-entry Content Editor panels:

### 1. Native Interactive Harness (`@dinkuskit/openclaw/native` + `@dinkuskit/openclaw/astro`)

Trusted in-process EmDash React Admin + SolidJS Web Component harness (`<openclaw-emdash-chat>`) with an Antigravity 2.0 &times; OpenClaw Control-UI workspace, live host-side SSE streaming, and a persistent Node `@openclaw/gateway-client@2026.11.1` Protocol v4 WebSocket bridge.

The native profile is not on npm yet. Install it from GitHub pinned to a commit; npm runs `prepare` (`npm run build`) on install, so `dist/` is built for you (Node 24):

```sh
npm install "github:dinkuskit/openclaw#<commit-sha>"
```

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { openclawNativePlugin } from "@dinkuskit/openclaw/native";
import { openclawBridge } from "@dinkuskit/openclaw/astro";

export default defineConfig({
  integrations: [
    openclawBridge(), // Mounts authenticated SSE route at /_emdash/api/openclaw/stream
    emdash({
      plugins: [openclawNativePlugin()],
    }),
  ],
});
```

- **Exports:**
  - `@dinkuskit/openclaw/native` &mdash; `openclawNativePlugin()` descriptor + `createPlugin()` runtime (`schema:read`, `content:read`, `content:revisions:read`, `network:request:unrestricted`; never `content:write`).
  - `@dinkuskit/openclaw/admin` &mdash; Thin React host adapters (`pages["/openclaw"]` and `contentEditorPanels`) mounting one precompiled SolidJS Shadow-DOM island (`<openclaw-emdash-chat>`).
  - `@dinkuskit/openclaw/astro` &amp; `@dinkuskit/openclaw/stream-endpoint` &mdash; Authenticated Astro host SSE bridge outside EmDash's buffered plugin route dispatcher (`locals.user.role >= 40` + per-user personal/shared audience filtering).

### 2. Sandboxed Registry Profile (`@dinkuskit/openclaw` + `@dinkuskit/openclaw/sandbox`)

Capability-gated sandboxed EmDash Registry plugin (`did:plc:ekk4pjmkh3k3ql2kfoex3qt4/dinkus-openclaw`, `backend.js` ~101 KiB with ~27 KiB headroom under EmDash's 128 KiB Registry limit) rendering an honest declarative Block Kit workspace (`@emdash-cms/blocks/server`) when the native Astro/React integration is not installed:

- **Shipped in the Registry sandbox (`0.1.0`):** Declarative `/openclaw` Block Kit workspace, **Agent Templates (`blobster.dev`)** install helper, dynamic collection discovery (`schema:read`), saved-entry `OpenClaw Assistant` side-panel, 1-step CSPRNG `/pair` MCP/REST bridge (`X-OpenClaw-Token` / JSON `sessionToken`), mid-task steering, encrypted `connection` settings, and `WAITING_FOR_HUMAN` proposal queues.
- **Native-only gaps (and what closes them):** Precompiled SolidJS `<openclaw-emdash-chat>` Antigravity UI island, unbuffered `/_emdash/api/openclaw/stream` SSE token streaming, and persistent Node `@openclaw/gateway-client` Protocol v4 WebSockets require `@dinkuskit/openclaw/native` + `@dinkuskit/openclaw/astro` until the EmDash plugin sandbox exposes streaming routes and outbound WebSocket transports (sandboxed installs pair external OpenClaw agents over HTTPS via `/pair`).

---

## Agent Templates & Custom Harnesses (`agents-template`)

`@dinkuskit/openclaw` includes first-class support for OpenClaw **Agent Templates** (`agents-template` / `openclaw templates`) so you can run verified agents from **[Blobster Factory (`blobster.dev`)](https://blobster.dev)** or your own local templates on any OpenClaw gateway or harness:

```sh
# 1. Enable Agent Templates on a fresh OpenClaw gateway
openclaw config set gateway.controlUi.experimental.templates true

# 2. Install a verified template tarball from Blobster Factory
template_dir="$(mktemp -d)"
curl --fail --show-error --location https://blobster.dev/t/blobster-smith.tgz -o "$template_dir/template.tgz"
mkdir "$template_dir/source"
tar -xzf "$template_dir/template.tgz" -C "$template_dir/source"
template_dir="$template_dir/source"
# npm-style archives have a package/ root; flat archives use the extraction root.
if [ -f "$template_dir/package/package.json" ]; then template_dir="$template_dir/package"; fi
openclaw templates validate "$template_dir"
openclaw templates add "$template_dir" --agent-id blobster-smith

# 3. Validate and install a local custom template directory during development
openclaw templates validate ./my-store-agent
openclaw templates add ./my-store-agent

# 4. Start the gateway; select blobster-smith in EmDash's Agent ID field
openclaw gateway run
```

- **Connect to `@dinkuskit/openclaw`:** Open **Agent Templates** inside `<openclaw-emdash-chat>` (or the **Agent Templates (`blobster.dev`)** tab in Block Kit), click **Use Agent ID** to pre-fill `agentId` in **Gateway &amp; Pairing** (`ws://127.0.0.1:18789` or `wss://...`), or run the generated `curl` `/pair` snippet from your harness.
- **Programmatic CLI helper:** `buildAgentTemplateInstallCommands(templateRef, siteOrigin, pairingCode?)` accepts any Blobster slug (`blobster-smith`), `.tgz` URL, or local path and returns shell-safe `enableTemplatesCommand`, `validateCommand`, `installCommand`, `harnessCommand`, and `pairCommand` strings. Archive install commands copy local archives or download URLs, then extract into a fresh temporary directory, validate the package, and add it with the selected agent ID; the directory is retained for inspection.
- **Discover &amp; Submit:** Browse verified templates at **[https://blobster.dev](https://blobster.dev)** and submit community `agents-template` packages at **[https://blobster.dev/submit](https://blobster.dev/submit)**.

### Cloudflare Workers (`workerd`) & Server-Locked EmDash Playground Mode

`@dinkuskit/openclaw/native` and `@dinkuskit/openclaw/stream-endpoint` ship dedicated `workerd`-safe ESM entrypoints (zero eager Node `ws` or `node:tls` imports) and fall back cleanly to `globalThis.fetch` for OpenClaw HTTP `/v1/chat/completions` turns (`model: "openclaw/<agentId>"`).

Server-configured loopback gateways use native fetch even when EmDash supplies its SSRF-protected HTTP client; redirects are refused on this path. Connections saved through the UI continue to use the host HTTP client.

For public EmDash Durable Object Playgrounds (where anonymous visitors receive isolated SQLite preview instances with `role: 50`), configure server-only `OPENCLAW_PLAYGROUND_*` variables (via `process.env` or `globalThis.__openclawPlaygroundEnv`):

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_PLAYGROUND_GATEWAY_URL` | Upstream OpenClaw HTTP(S) Gateway origin (e.g. `http://127.0.0.1:19011` or `https://...`) |
| `OPENCLAW_PLAYGROUND_GATEWAY_TOKEN` | Server-only Gateway bearer token (never persisted to visitor SQLite or exposed to browsers) |
| `OPENCLAW_PLAYGROUND_AGENT_ID` | Default Playground agent ID (defaults to `blobster-smith`) |
| `OPENCLAW_PLAYGROUND_ENABLED_COLLECTIONS` | Comma-separated enabled collections (e.g. `templates,pages`) |
| `OPENCLAW_PLAYGROUND_LOCK` | Set `"1"` to lock Gateway settings, block `/pair` &amp; SSRF mutations, and disable inline exec approvals |
| `OPENCLAW_PLAYGROUND_CF_ACCESS_CLIENT_ID` / `_SECRET` | Optional origin-bound Cloudflare Access service-token headers for private Gateway tunnels |

Anonymous Playground sessions automatically hash the `emdash_playground` cookie (or `x-openclaw-playground-visitor` header) with SHA-256 (`agent:<agentId>:pg-<visitorHash>:<convId>`) so concurrent visitors never share agent session memory.

---

## Security & Authority Model

1. **Server-Owned OpenClaw Gateway Protocol v4 Bridge (`src/gateway-bridge.ts`):**
   - Uses `@openclaw/gateway-client@2026.11.1` (`PROTOCOL_VERSION` v4) over loopback `ws://127.0.0.1` / `ws://localhost` or TLS `wss://` (rejecting non-loopback cleartext `ws://`).
   - Generates and persists an Ed25519 device identity (`ed25519:...`), bootstrap/gateway token, and issued `deviceToken` inside EmDash's encrypted `ctx.settings("connection")` secret store&mdash;never exposed to browser JS.
   - Supports `#token=` Control UI fragment paste extraction, `sessions.messages.subscribe` live delta &amp; tool streaming, mid-run `chat.send` (`queueMode: "steer"`), and `chat.abort` (session-scoped without `sessionId`).
2. **Dual Approval Authority (`src/chat-engine.ts`, `src/ui/openclaw-chat-element.tsx`):**
   - **EmDash CMS Draft Proposals (`CMS Draft &middot; rev #N`):** Editors (`role >= 40`) review field diffs against draft-safe fields (excluding SEO and live publication status metadata) and save drafts through same-origin `GET/PUT /_emdash/api/content/:collection/:id` guarded by EmDash `_rev` optimistic concurrency.
   - **Immutable `"Edit & Approve"` &amp; Receipt Reconciliation:** Editing a proposal (`revise_proposal`) marks the parent `superseded` and mints `revisionNumber + 1`. Browser receipts (`applied` / `outcome_unknown`) are verified server-side against stored EmDash content and staged draft revisions (`content:revisions:read`) to prevent duplicate writes.
   - **OpenClaw Gateway Execution Approvals (`Gateway Approval &middot; exec | plugin | system-agent`):** Permission to edit CMS content **never** grants Gateway execution approval authority. Execution approvals render as read-only handoff cards (`Review in Gateway Control UI &nearr;`) unless the viewer is a **Site Administrator (`role >= 50`)**, explicit `allowGatewayExecApprovals` opt-in is enabled, and the Gateway connection holds `operator.approvals` scope.
3. **Per-User Thread Isolation & Hardened MCP Pairing (`src/admin.ts`, `src/stream-endpoint.ts`):**
   - Conversations default to `visibility: "personal"` (`ownerUserId`-scoped in both workspace snapshots and live SSE streams) with an explicit topbar `Personal` / `Shared` toggle.
   - Public `/pair` requires a CSPRNG 15-minute admin pairing code to mint a scoped `sessionToken`, and MCP `tools/call` / REST polling enforce `X-OpenClaw-Token: <sessionToken>` or JSON `sessionToken`.

---

## Mascot: DinkusClaw

`dinkuskit/openclaw`'s identity is embodied by **DinkusClaw** &mdash; a streetwear cyber-crustacean mascot sporting an oversized matte obsidian techwear hoodie with bold crimson cords, carbon-fiber claw gauntlets, and a glowing red holographic HUD visor.

See the complete [DinkusClaw Character Ecosystem &amp; Extended Spec](docs/design/dinkusclaw-character-and-pet-rig.md) for master turnarounds, 6-state expression sheets, and GitHub App avatar packs.

---

## Verification

```sh
npm install
./bin/verify-openclaw full
```

## Status

Published on the EmDash Plugin Registry as `dinkus-openclaw@0.1.0` (`did:plc:ekk4pjmkh3k3ql2kfoex3qt4/dinkus-openclaw`, publisher `dinkuskit.com`). MIT.

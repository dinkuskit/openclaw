# @dinkuskit/openclaw

`* * *`

Connect custom [OpenClaw](https://github.com/openclaw) agents and gateways to [EmDash CMS](https://github.com/emdash-cms/emdash) and [DinkusKit](https://github.com/dinkuskit) stores (`dinkus-openclaw`).

> **Gateway owns conversation execution. EmDash owns CMS mutations. The bridge connects them; the UI projects their state.**

## Installation Profiles

`@dinkuskit/openclaw` ships two mutually exclusive installation profiles sharing the `dinkus-openclaw` product identity so both mount cleanly at `/_emdash/admin/plugins/dinkus-openclaw/openclaw` and in saved-entry Content Editor panels:

### 1. Native Interactive Harness (`@dinkuskit/openclaw/native` + `@dinkuskit/openclaw/astro`)

Trusted in-process EmDash React Admin + SolidJS Web Component harness (`<openclaw-emdash-chat>`) with an Antigravity 2.0 × OpenClaw Control-UI workspace, live host-side SSE streaming, and a persistent Node `@openclaw/gateway-client@2026.11.1` Protocol v4 WebSocket bridge.

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
  - `@dinkuskit/openclaw/native` — `openclawNativePlugin()` descriptor + `createPlugin()` runtime (`schema:read`, `content:read`, `content:revisions:read`, `network:request:unrestricted`; never `content:write`).
  - `@dinkuskit/openclaw/admin` — Thin React host adapters (`pages["/openclaw"]` and `contentEditorPanels`) mounting one precompiled SolidJS Shadow-DOM island (`<openclaw-emdash-chat>`).
  - `@dinkuskit/openclaw/astro` & `@dinkuskit/openclaw/stream-endpoint` — Authenticated Astro host SSE bridge outside EmDash's buffered plugin route dispatcher (`locals.user.role >= 40` + per-user personal/shared audience filtering).

### 2. Sandboxed Registry Profile (`@dinkuskit/openclaw` + `@dinkuskit/openclaw/sandbox`)

Capability-gated sandboxed Registry plugin (`backend.js` ~52 KiB, well under EmDash's 128 KiB Registry limit) rendering an honest declarative Block Kit fallback (`@emdash-cms/blocks/server`) with pairing, authority controls, and approval queues when the native Astro/React integration is not installed.

## Security & Authority Model

1. **Server-Owned OpenClaw Gateway Protocol v4 Bridge (`src/gateway-bridge.ts`):**
   - Uses `@openclaw/gateway-client@2026.11.1` (`PROTOCOL_VERSION` v4) over loopback `ws://127.0.0.1` / `ws://localhost` or TLS `wss://` (rejecting non-loopback cleartext `ws://`).
   - Generates and persists an Ed25519 device identity (`ed25519:...`), bootstrap/gateway token, and issued `deviceToken` inside EmDash's encrypted `ctx.settings("connection")` secret store—never exposed to browser JS.
   - Supports `#token=` Control UI fragment paste extraction, `sessions.messages.subscribe` live delta & tool streaming, mid-run `chat.send` (`queueMode: "steer"`), and `chat.abort` (session-scoped without `sessionId`).
2. **Dual Approval Authority (`src/chat-engine.ts`, `src/ui/openclaw-chat-element.tsx`):**
   - **EmDash CMS Draft Proposals (`CMS Draft · rev #N`):** Editors (`role >= 40`) review field diffs against draft-safe fields (excluding SEO and live publication status metadata) and save drafts through same-origin `GET/PUT /_emdash/api/content/:collection/:id` guarded by EmDash `_rev` optimistic concurrency.
   - **Immutable `"Edit & Approve"` & Receipt Reconciliation:** Editing a proposal (`revise_proposal`) marks the parent `superseded` and mints `revisionNumber + 1`. Browser receipts (`applied` / `outcome_unknown`) are verified server-side against stored EmDash content and staged draft revisions (`content:revisions:read`) to prevent spoofed receipts and recover interrupted network responses without duplicate writes.
   - **OpenClaw Gateway Execution Approvals (`Gateway Approval · exec | plugin | system-agent`):** Permission to edit CMS content **never** grants Gateway execution approval authority. Execution approvals render as read-only handoff cards (`Review in Gateway Control UI ↗`) unless the viewer is a **Site Administrator (`role >= 50`)**, explicit `allowGatewayExecApprovals` opt-in is enabled, and the Gateway connection holds `operator.approvals` scope.
3. **Per-User Thread Isolation & Hardened MCP Pairing (`src/admin.ts`, `src/stream-endpoint.ts`):**
   - Conversations default to `visibility: "personal"` (`ownerUserId`-scoped in both workspace snapshots and live SSE streams) with an explicit topbar `🔒 Personal` / `👥 Shared` toggle.
   - Public `/pair` requires a CSPRNG 15-minute admin pairing code to mint a scoped `sessionToken`, and MCP `tools/call` / REST polling enforce `X-OpenClaw-Token: <sessionToken>` or JSON `sessionToken` (with `Authorization: Bearer <sessionToken>` also accepted on the native profile).

## Verification

```sh
npm install
./bin/verify-openclaw full
```

## Status

Public runnable plugin (`0.0.0`, `private: true`). MIT.

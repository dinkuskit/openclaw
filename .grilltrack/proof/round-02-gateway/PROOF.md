# Proof — Round 02 OpenClaw Gateway Protocol v4 Bridge, Dual Approval Authority & Milestone-1 Hardening

- **Track:** `gt-20261108044955-5e6a3e`
- **Branch:** `feat/native-openclaw-chat`
- **Decisions Verified:**
  - `gateway-transport-004` (`durable`): Server-owned `@openclaw/gateway-client@2026.11.1` Protocol v4 WebSocket bridge (`ws://127.0.0.1` loopback + `wss://` remote), Ed25519 device identity + encrypted `ctx.settings("connection")` storage, live `sessions.messages.subscribe` streaming, mid-run `steer`, and `chat.abort`.
  - `dual-approval-authority-005` (`durable`): Separate CMS draft approval (`role >= 40` + `_rev` optimistic concurrency) vs OpenClaw Gateway execution approval (`role >= 50` Site Admin + explicit `allowGatewayExecApprovals` opt-in + `operator.approvals` scope; read-only Control UI handoff card otherwise).
  - `milestone-1-hardening-006` (`slice`): Bearer `sessionToken` auth on `/pair` MCP `tools/call`, CSPRNG 15-minute expiring pairing codes, per-user `personal` vs `shared` conversation threads + SSE audience isolation, immutable `revise_proposal` (`rev #1 -> superseded`, `rev #2`), draft-safe field guard, and server-side receipt reconciliation via `content:revisions:read`.

## Automated Verification (`./bin/verify-openclaw full`)

- `tsc --noEmit`: pass
- `emdash-plugin validate && emdash-plugin build`: pass
- `node scripts/build-native.mjs`: `native_harness_build=pass`
- `node scripts/check-registry-bundle.mjs`: `registry_bundle=pass backend_bytes=51996 headroom_bytes=79076` (under `131072` byte Registry limit)
- `node --test tests/*.test.mjs`: **8/8 passing** (`tests/admin.test.mjs`, `tests/gateway-bridge.test.mjs`, `tests/native-harness.test.mjs`)

## Sanitized Local Browser Captures (`1512x945`, EmDash `v1.4.0` + Astro `v7.1.3`)

Stored locally (git-ignored binary PNGs per repository hygiene):

1. `round2-01-gateway-v4-dual-authority.png`
   - **Bytes:** `559626`
   - **SHA-256:** `e6305be007b4095ea25f571f32369ff293a2eee5a6c976b798a78e1822740fce`
   - **Claim shown:** Live Gateway Protocol v4 turn (`@roboclaw · GW v4`, `🔒 Personal`), expandable `emdash.content.list` & `openclaw.catalog.audit` tool rows, purple `Gateway Approval · exec` card in default Read-Only Control UI handoff mode, and coral `CMS Draft · rev #1` card bound to live EmDash `_rev`.
2. `round2-02-gateway-v4-pairing-drawer.png`
   - **Bytes:** `612878`
   - **SHA-256:** `71d4ded0af82c9e45e4be68707c29c1afe64407400f4c433ea1cfca419ca6bca`
   - **Claim shown:** `OpenClaw Gateway v4 & Agent Pairing` modal showing `● connected · protocol v4`, `ed25519:...` device identity stored encrypted in EmDash settings, `operator.read` / `operator.write` / `operator.approvals` scope pills, Site-Admin inline execution approval opt-in, and 15-minute expiring pairing command.
3. `round2-03-admin-exec-resolved-and-rev2.png`
   - **Bytes:** `538627`
   - **SHA-256:** `e4696c86f17b6a0cf09ba157b1c06694703c0d68cd8034fa2a561bf34f813621`
   - **Claim shown:** Topbar `👥 Shared` + `● @roboclaw · GW v4`, Site-Admin inline resolution of `Gateway Approval · exec` (`✓ Allowed (allow-once)`), and immutable `CMS Draft · rev #2` (`edited`) saved as an EmDash draft revision and verified server-side (`✓ Applied (... · verified)`) via `content:revisions:read`, with `rev #1` recorded `superseded` in the right `Overview` inspector.

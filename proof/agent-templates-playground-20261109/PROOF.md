# Agent Templates & Cloudflare Workers / Playground Compatibility Proof (`2026-11-09`)

- **Repository**: `dinkuskit/openclaw`
- **Branch**: `feat/agent-templates-and-playground`
- **Base Commit**: `4b323394af5fa18fac3085db84d0c89e674e0eb1` (`release/dinkus-openclaw-0.1.0` / `main`)
- **Redaction & Privacy Status**: Public-safe source, synthetic test fixtures (`*.example.test`, `*.example.com`), and public `https://blobster.dev` catalog URLs only; zero credentials, secrets, local machine paths, or private infrastructure hostnames.

---

## Claims Proven

1. **First-Class OpenClaw Agent Templates (`agents-template` / `openclaw templates`)**:
   - Added typed `AgentTemplateEntry` metadata (`blobster-smith` and `blobster-sculptor` at `https://blobster.dev/t/<slug>.tgz`) plus `catalogUrl` (`https://blobster.dev`) and `submitUrl` (`https://blobster.dev/submit`) to `OpenClawWorkspaceSnapshot`.
   - Exported `buildAgentTemplateInstallCommands(templateRef, siteOrigin, pairingCode?)` handling catalog slugs, `.tgz` tarball URLs, and local directories with shell-safe argument escaping (`openclaw config set gateway.controlUi.experimental.templates true`, `openclaw templates validate`, `openclaw templates add`, `--agent-id`, and `/pair` curl snippet).
   - Added tactile **Agent Templates** launcher + drawer in `<openclaw-emdash-chat>` (`src/ui/openclaw-chat-element.tsx`, `src/ui/styles.ts`) with 1-click Copy buttons, `Use Agent ID` Gateway Settings pre-fill, custom template builder, and external links to `https://blobster.dev` and `https://blobster.dev/submit`.
   - Added valid declarative Block Kit **Agent Templates (`blobster.dev`)** sections on both `setupPage` and connected `workspacePage` (`src/admin.ts`).

2. **Cloudflare Workers (`workerd`) & Server-Locked EmDash Playground Mode**:
   - Split Node-only `@openclaw/gateway-client` (`ws`, `node:tls`, `node:crypto`) into `dist/gateway-bridge.mjs` loaded lazily only on true Node runtimes, emitted pure Web-standard `dist/native.workerd.mjs` (`exports["./native"].workerd`) and `dist/stream-endpoint.mjs` with zero `node:*` or `ws` imports.
   - Added `globalThis.fetch` fallback in `tryExternalHttpGatewayTurn` when `ctx.http` is absent on native in-process EmDash plugins, passing `model: "openclaw/<agentId>"`, `x-openclaw-agent-id`, `x-openclaw-scopes: "operator.write"`, `x-openclaw-session-key`, `user: sessionKey`, and optional origin-bound `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
   - Implemented server-locked `OPENCLAW_PLAYGROUND_*` env mode (`process.env` and `globalThis.__openclawPlaygroundEnv`) returning connected `propose_with_approval` state (`allowGatewayExecApprovals: false`, `gatewayBridge: { available: true, state: "connected" }`) without writing secrets to visitor SQLite or exposing tokens to browsers, blocking settings/SSRF/`/pair`/exec-approval mutations under `OPENCLAW_PLAYGROUND_LOCK=1`, and hashing `emdash_playground` cookie / `x-openclaw-playground-visitor` header via WebCrypto SHA-256 (`agent:<agentId>:pg-<visitorHash>:<convId>`).

---

## Package Budget & Verification Output

| Metric | Baseline (`4b32339`) | Candidate | Limit | Headroom |
| --- | ---: | ---: | ---: | ---: |
| Packaged `backend.js` | `94,376 B` | `103,372 B` | `131,072 B` | `27,700 B` |
| Unit & Integration Tests | `16 / 16` | `19 / 19` | — | Pass |

Commands verified:

```sh
./bin/verify-openclaw full
# tsc --noEmit -> pass
# emdash-plugin validate && emdash-plugin build -> pass
# node scripts/build-native.mjs -> native_harness_build=pass
# node scripts/check-registry-bundle.mjs -> registry_bundle=pass backend_bytes=103372 headroom_bytes=27700
# node --test tests/*.test.mjs -> 19/19 pass
```

## Gates

- **Merge / Registry Publication**: `WAITING_FOR_HUMAN` (do not self-merge or publish to npm / EmDash Registry without explicit owner approval).

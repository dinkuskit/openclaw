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
   - Added `globalThis.fetch` fallback in `tryExternalHttpGatewayTurn` when `ctx.http` is absent on native in-process EmDash plugins, and uses native fetch for loopback (`127.0.0.1` / `localhost` / `[::1]`) only when the connection comes from exact server-trusted `OPENCLAW_PLAYGROUND_GATEWAY_URL` configuration, while retaining `ctx.http.fetch` for user-configured URLs; passes `model: "openclaw/<agentId>"`, `x-openclaw-agent-id`, `x-openclaw-scopes: "operator.write"`, `x-openclaw-session-key`, `user: sessionKey`, and optional origin-bound `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
   - Implemented server-locked `OPENCLAW_PLAYGROUND_*` env mode (`process.env` and `globalThis.__openclawPlaygroundEnv`) returning connected `propose_with_approval` state (`allowGatewayExecApprovals: false`, `gatewayBridge: { available: true, state: "connected" }`) without writing secrets to visitor SQLite or exposing tokens to browsers, blocking settings/SSRF/`/pair`/exec-approval mutations under `OPENCLAW_PLAYGROUND_LOCK=1`, and hashing `emdash_playground` cookie / `x-openclaw-playground-visitor` header via WebCrypto SHA-256 (`agent:<agentId>:pg-<visitorHash>:<convId>`).

---

## Package Budget & Verification Output

| Metric | Baseline (`4b32339`) | Candidate | Limit | Headroom |
| --- | ---: | ---: | ---: | ---: |
| Packaged `backend.js` | `94,376 B` | `103,652 B` | `131,072 B` | `27,420 B` |
| Unit & Integration Tests | `16 / 16` | `19 / 19` | — | Pass |

Commands verified:

```sh
./bin/verify-openclaw full
# tsc --noEmit -> pass
# emdash-plugin validate && emdash-plugin build -> pass
# node scripts/build-native.mjs -> native_harness_build=pass
# node scripts/check-registry-bundle.mjs -> registry_bundle=pass backend_bytes=103652 headroom_bytes=27420
# node --test tests/*.test.mjs -> 19/19 pass
```

## Gates

- **Merge / Registry Publication**: `WAITING_FOR_HUMAN` (do not self-merge or publish to npm / EmDash Registry without explicit owner approval).

## Autoreview repair verification

The review of `d61dbf69dfd641458dc335f80a0ceb6bff6a67fa` against
`686a3a8f898f2993456612d4f36a3269ab37687f` identified three confirmed dependency
contract mismatches, each classified `required_fix` and addressed here:

1. OpenClaw accepts an extracted package directory or `CLAW.md`, rather than a
   tarball URL. Featured, custom, and Block Kit commands now copy/download archives
   into a fresh temporary directory, extract into a separate source directory,
   validate, and add the local package. Flat and `package/` archive roots are
   supported. Local `.tgz` / `.tar.gz` inputs use the same extraction path.
   Source: [OpenClaw template source contract](https://docs.openclaw.ai/cli/templates).
2. `gateway run` does not accept `--agent-id`. Generated setup uses
   `templates add --agent-id` to select the agent and `openclaw gateway run` to
   start the Gateway. Source:
   [OpenClaw v2026.11.1 gateway options](https://github.com/openclaw/openclaw/blob/v2026.11.1/src/cli/gateway-cli/run-command.ts).
3. EmDash 1.4.0 supplies `ctx.http` for this plugin's declared capabilities and
   validates targets even in its unrestricted client, rejecting loopback.
   A connection resolved from server-only Playground configuration may now use
   native fetch for its exact configured loopback URL and token; that request
   refuses redirects. Persisted connections retain the host client. Sources:
   [EmDash 1.4.0 plugin context](https://github.com/emdash-cms/emdash/blob/emdash%401.4.0/packages/core/src/plugins/context.ts)
   and [SSRF validation](https://github.com/emdash-cms/emdash/blob/emdash%401.4.0/packages/core/src/security/ssrf.ts).

Regression proof in `tests/templates-and-playground.test.mjs` executes generated
shell installation commands using real `sh`, `tar`, local fixture archives and
stubbed download/CLI executables. It verifies flat and npm-style archive roots,
local archive inputs, shell metacharacters, selected agent IDs, and no installation
after download failure. The transport test supplies `ctx.http` and proves that
only the server-owned loopback connection uses native fetch with `redirect: error`;
a stored connection at the same origin still goes through the rejecting host client.
These are local fixtures and mocked HTTP calls, not deployed Gateway or browser proof.

A public request for the Blobster Smith archive returned HTTP 403 during this
verification. Its current contents and availability are therefore unverified;
archive-root support is proved with fixtures. No account change, deployment,
publication, or production Gateway request was performed.

Final validation: `./bin/verify-openclaw full` and the required pre-commit
`./bin/verify-openclaw quick` both passed typecheck, Registry/native builds,
and all 21 tests. `git diff --check` passed. The backend is 106,239 bytes
with 24,833 bytes headroom against the 131,072-byte cap. See the reviewer
closeout for the final source SHA. All pre-existing proof above
records the original candidate; this section records the repairs.


## Combined candidate

The integrated candidate preserves remote commit
`1b658a7949cc7759ede2afbe12e7b4b2edf381d8` as an ancestor and applies the
repairs prepared in `647375ac9f9b948eb5537031dc56db217970052b`. Its additional
process-environment and manual-loopback regression cases are retained. The
manual-loopback case now requires the host HTTP rejection, matching the narrow
server-owned exception rather than allowing visitor-saved URLs to bypass it.
The shared loopback URL classifier is retained; the exact configured URL,
credential match, server-source flag and redirect refusal remain required.

Integrated validation: `./bin/verify-openclaw full` passed all 21 tests,
typecheck, Registry validation/build and native builds. The integrated backend
is 106,325 bytes with 24,747 bytes headroom against 131,072 bytes.
`git diff --check` and the required pre-commit `./bin/verify-openclaw quick`
also passed (21/21 tests). The reviewer closeout records the exact source head.


## Rendered Block Kit command regression

The next review identified a function reference accidentally included in the
Agent Templates Bash code array. Joining that array rendered JavaScript function
source into both the setup and connected workspace pages. The reference was
removed; the intended command string remains.

The regression extends the existing Agent Templates test to walk the actual
nested Block Kit responses from both pages, require exactly one template Bash
block, reject embedded JavaScript source, assert the intended enable/install
commands, and parse each script with `sh -n` without executing it. It failed
against the prior built source and passes with the fix. This is rendered response
and shell-syntax proof; it does not claim browser or live Gateway execution.

`./bin/verify-openclaw quick` passed all 21 tests, typecheck and both builds after
this repair. Backend: 106,323 bytes, 24,749 bytes headroom;
SHA-256: `0d077eab07136b71109f6bc09788ed6400062428d186ce35eedffdba12c65287`.
`git diff --check` passed. The repair diff was also checked for other bare helper
references; remaining references are imports, exports, or function calls.

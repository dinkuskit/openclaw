# openclaw

`* * *`

Connect custom [OpenClaw](https://github.com/openclaw) agents and gateways to
[EmDash CMS](https://github.com/emdash-cms/emdash) and
[DinkusKit](https://github.com/dinkuskit) stores. Planned package:
`@dinkuskit/openclaw` (plugin slug `dinkus-openclaw`).

Built so site owners and teams who already run an OpenClaw gateway can bring
their custom agents directly into the EmDash Admin—reading schemas and content,
proposing editor draft patches (`admin.editor-draft:patch`), invoking site MCP
tools, and surfacing `WAITING_FOR_HUMAN` Block Kit approval cards before any
mutation takes effect.

## Architecture

- **Lean Sandboxed Registry Plugin (`dinkus-openclaw`):** Runs inside EmDash's
  capability-gated sandbox (`< 128 KiB` `backend.js` limit) with a declarative
  Block Kit admin page (`/_emdash/admin/openclaw`).
- **External OpenClaw Gateway Execution:** The OpenClaw runtime stays on your
  gateway host and connects back to the site's permissioned EmDash MCP server
  and plugin routes—no direct plugin-to-plugin coupling inside the sandbox.
- **Read-Only Default & Human Gates:** Starts in `read_only` mode by default and
  requires explicit administrator setup plus `WAITING_FOR_HUMAN` approval cards
  for proposed mutations.

## Verification

```sh
npm install
npm run verify:quick
```

## Status

Public runnable plugin scaffold (`0.0.0`, `private: true`). MIT.

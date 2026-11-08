import { build } from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const tmpDir = resolve(root, ".tmp/solid-build");
const distDir = resolve(root, "dist");

await rm(tmpDir, { recursive: true, force: true });
await mkdir(tmpDir, { recursive: true });
await mkdir(distDir, { recursive: true });

// 1. Precompile the SolidJS custom element island (`<openclaw-emdash-chat>`) in isolation
// so Solid's fine-grained JSX compiler never collides with React's JSX runtime.
const precompiledElementPath = resolve(tmpDir, "openclaw-chat-element.mjs");
await build({
  entryPoints: [resolve(root, "src/ui/openclaw-chat-element.tsx")],
  outfile: precompiledElementPath,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  plugins: [solidPlugin()],
});

// 2. Bundle the React `adminEntry` (`pages["/openclaw"]` + `contentEditorPanels`),
// keeping `react` external so EmDash's host React instance owns hooks & context.
await build({
  entryPoints: [resolve(root, "src/react-admin.tsx")],
  outfile: resolve(distDir, "admin.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  external: ["react", "react/jsx-runtime", "react-dom"],
  plugins: [
    {
      name: "alias-precompiled-solid-element",
      setup(buildCtx) {
        buildCtx.onResolve({ filter: /openclaw-chat-element\.js$/ }, () => ({
          path: precompiledElementPath,
        }));
      },
    },
  ],
});

const nodeHostExternals = [
  "emdash",
  "emdash/*",
  "@emdash-cms/*",
  "@openclaw/gateway-client",
  "@openclaw/gateway-client/*",
  "@openclaw/gateway-protocol",
  "@openclaw/gateway-protocol/*",
  "ws",
  "ipaddr.js",
  "node:*",
];

// 3. Bundle the trusted native EmDash plugin entrypoint (`createPlugin` + `openclawNativePlugin`)
await build({
  entryPoints: [resolve(root, "src/native.ts")],
  outfile: resolve(distDir, "native.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  external: nodeHostExternals,
});

// 4. Bundle the Astro SSE host bridge integration & stream endpoint
await build({
  entryPoints: [resolve(root, "src/astro.ts")],
  outfile: resolve(distDir, "astro.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  external: nodeHostExternals,
});

await build({
  entryPoints: [resolve(root, "src/stream-endpoint.ts")],
  outfile: resolve(distDir, "stream-endpoint.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  external: nodeHostExternals,
});

// 5. Emit lightweight TypeScript declaration shims for `./native`, `./admin`, and `./astro`
await writeFile(
  resolve(distDir, "native.d.mts"),
  [
    'import type { PluginDescriptor, ResolvedPlugin } from "emdash";',
    "export interface OpenClawNativePluginOptions { entrypoint?: string; adminEntry?: string; }",
    "export declare function createPlugin(): ResolvedPlugin;",
    "export declare function openclawNativePlugin(options?: OpenClawNativePluginOptions): PluginDescriptor;",
    "export default createPlugin;",
    "",
  ].join("\n"),
);

await writeFile(
  resolve(distDir, "admin.d.mts"),
  [
    'import type * as React from "react";',
    "export declare const pages: Record<string, React.ComponentType>;",
    "export declare const contentEditorPanels: readonly unknown[];",
    "",
  ].join("\n"),
);

await writeFile(
  resolve(distDir, "astro.d.mts"),
  [
    "export interface OpenClawBridgeOptions { streamEntrypoint?: string; }",
    "export declare function openclawBridge(options?: OpenClawBridgeOptions): { name: string; hooks: Record<string, unknown> };",
    "export default openclawBridge;",
    "",
  ].join("\n"),
);

console.log("native_harness_build=pass");

import { bundlePlugin } from "@emdash-cms/plugin-cli";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const REGISTRY_FILE_LIMIT_BYTES = 128 * 1024;
const directory = resolve(".tmp/registry-bundle");
await rm(directory, { recursive: true, force: true });
const extracted = resolve(directory, "extracted");
await mkdir(extracted, { recursive: true });
const artifact = await bundlePlugin({ dir: resolve("."), outDir: resolve(directory, "build") });
execFileSync("tar", ["-xf", artifact.tarballPath, "-C", extracted]);
const backend = await readFile(resolve(extracted, "backend.js"));
if (backend.byteLength > REGISTRY_FILE_LIMIT_BYTES) {
  throw new Error(
    `backend.js (${backend.byteLength} bytes) exceeds Registry per-file limit (${REGISTRY_FILE_LIMIT_BYTES} bytes)`,
  );
}
const manifest = JSON.parse(await readFile(resolve(extracted, "manifest.json"), "utf8"));
if (manifest.id !== "dinkus-openclaw") {
  throw new Error(`unexpected plugin id ${manifest.id}`);
}
if (manifest.routes.some(route => route.public && route.name !== "pair")) {
  throw new Error("only the one-time 'pair' route may be public on the OpenClaw plugin");
}
console.log([
  "registry_bundle=pass",
  `backend_bytes=${backend.byteLength}`,
  `headroom_bytes=${REGISTRY_FILE_LIMIT_BYTES - backend.byteLength}`,
  `backend_sha256=${createHash("sha256").update(backend).digest("hex")}`,
  `capabilities=${manifest.capabilities.join(",")}`,
].join(" "));

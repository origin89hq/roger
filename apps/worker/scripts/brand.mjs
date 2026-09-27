// Copies the brand files the inbox uses into public/brand/, checking each
// against the package manifest's SHA-256, and records what was copied.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = [
  "tokens/themes.css",
  "fonts/InterTight-Variable.ttf",
  "fonts/InterTight-OFL.txt",
  "fonts/IBMPlexMono-Regular.ttf",
  "fonts/IBMPlexMono-OFL.txt",
  "logos/plate-89-blue.svg",
  "icons/favicon.ico",
];

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@origin89/brand/brand.json"));
const manifest = JSON.parse(await readFile(join(root, "brand.json"), "utf8"));
const listed = new Map(
  Object.values(manifest.files)
    .flat()
    .map((entry) => [entry.file, entry.sha256]),
);
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "brand",
);
const copied = [];
for (const file of FILES) {
  const expected = listed.get(file);
  if (!expected)
    throw new Error(`${file} is not in @origin89/brand ${manifest.version}`);
  const bytes = await readFile(join(root, file));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected)
    throw new Error(`${file} does not match the brand manifest`);
  await mkdir(dirname(join(out, file)), { recursive: true });
  await writeFile(join(out, file), bytes);
  copied.push({ file, sha256: actual });
}
await writeFile(
  join(out, "provenance.json"),
  `${JSON.stringify({ package: "@origin89/brand", version: manifest.version, files: copied }, null, 2)}\n`,
);

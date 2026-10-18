// npm run release: builds dist/townsfolk-vX.Y.Z.zip, the file players download.
//
// Refuses to build unless mod/manifest.json, mod/Townsfolk.csproj and brain/package.json carry
// the same version and CHANGELOG.md has a "## X.Y.Z" entry. Builds the mod in Release with
// EnableModDeploy=false, so nothing is copied into a Mods folder. DOTNET is the dotnet binary
// (default "dotnet"; on the mini, DOTNET=~/.dotnet/dotnet).
//
// Zip layout: one Townsfolk/ folder that the player drops into Mods. The brain sits inside it,
// so the zip unzips into Mods as a single folder and SMAPI sees one mod. SMAPI loads only the
// EntryDll, so brain/ and the start files are ignored by the game.
//
//   Townsfolk/manifest.json, Townsfolk.dll       the SMAPI mod
//   Townsfolk/README.txt                          player instructions (release/README.txt)
//   Townsfolk/start-brain.cmd, start-brain.sh     start the brain (host only)
//   Townsfolk/brain/start.mjs, package.json, src/**/*.ts (every subfolder, e.g. src/cards/)
//
// After the zip is written, the release unzips its own copy into a temp folder and starts the
// brain from it with TOWNSFOLK_MODEL=fake on a free port. The release fails (and deletes the zip)
// unless /v1/health answers. v0.1.0 skipped this and shipped without src/cards/roster.ts.

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type Versions = { manifest: string; csproj: string; brain: string; changelog: string };

export function readVersions(root: string): Versions {
  const manifest = (JSON.parse(readFileSync(join(root, "mod", "manifest.json"), "utf8")) as { Version: string }).Version;
  const brain = (JSON.parse(readFileSync(join(root, "brain", "package.json"), "utf8")) as { version: string }).version;
  const csproj = /<Version>([^<]+)<\/Version>/.exec(readFileSync(join(root, "mod", "Townsfolk.csproj"), "utf8"))?.[1];
  if (csproj === undefined) throw new Error("mod/Townsfolk.csproj has no <Version>");
  const headings = [...readFileSync(join(root, "CHANGELOG.md"), "utf8").matchAll(/^## (\S+)/gm)].map((m) => m[1]);
  return { manifest, csproj, brain, changelog: headings.join(" ") };
}

export function versionProblem(v: Versions): string | null {
  if (v.manifest !== v.brain || v.csproj !== v.brain) {
    return `versions differ: mod/manifest.json ${v.manifest}, mod/Townsfolk.csproj ${v.csproj}, brain/package.json ${v.brain}`;
  }
  if (!v.changelog.split(" ").includes(v.brain)) return `CHANGELOG.md has no "## ${v.brain}" heading`;
  return null;
}

export type Entry = { name: string; data: Buffer; executable: boolean };

// A plain zip (deflate, fixed timestamps so the same input gives the same bytes).
export function zip(entries: Entry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, so the mode below is honoured
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Every .ts file under dir, subfolders included, as "/"-separated paths relative to dir, sorted.
export function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(dir, rel));
    else if (e.name.endsWith(".ts")) out.push(rel);
  }
  return out.sort();
}

// Reads back the entries of a zip written by zip() above (deflate only, sizes in the central
// directory). Used to unpack the release's own copy for the smoke check.
export function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error("not a zip written by this script");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, data: inflateRawSync(buf.subarray(start, start + packed)) });
    p += 46 + nameLen;
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

// Unzips the zip into a temp folder and starts the brain from there with TOWNSFOLK_MODEL=fake on a
// free port. Resolves with the /v1/health body when it answers; rejects with the brain's own
// output when it does not (for example ERR_MODULE_NOT_FOUND for a file the zip left out).
export async function smokeZip(zipPath: string, nodeBin = process.execPath): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "townsfolk-release-"));
  try {
    for (const e of unzip(readFileSync(zipPath))) {
      const file = join(dir, ...e.name.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, e.data);
    }
    const port = await freePort();
    const state = join(dir, "state");
    const child = spawn(nodeBin, [join(dir, "Townsfolk", "brain", "start.mjs")], {
      env: { ...process.env, TOWNSFOLK_MODEL: "fake", TOWNSFOLK_PORT: String(port), TOWNSFOLK_STATE_DIR: state },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (output += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (output += d));
    let exited = false;
    child.on("close", () => (exited = true));
    try {
      for (let i = 0; i < 100 && !exited; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
          if (res.ok) return JSON.stringify(await res.json());
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`the unzipped brain did not answer /v1/health on port ${port}:\n${output.slice(0, 1500)}`);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const crlf = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const v = readVersions(root);
  const problem = versionProblem(v);
  if (problem) {
    console.error(`release refused: ${problem}`);
    process.exit(1);
  }
  const version = v.brain;

  const dotnet = process.env.DOTNET ?? "dotnet";
  execFileSync(dotnet, ["build", "-c", "Release", "-p:EnableModDeploy=false", "-p:EnableModZip=false", "-nologo", "-v", "quiet"], {
    cwd: join(root, "mod"),
    stdio: "inherit",
  });
  const dll = readFileSync(join(root, "mod", "bin", "Release", "net6.0", "Townsfolk.dll"));

  const read = (...p: string[]) => readFileSync(join(root, ...p));
  const entries: Entry[] = [
    { name: "Townsfolk/manifest.json", data: read("mod", "manifest.json"), executable: false },
    { name: "Townsfolk/Townsfolk.dll", data: dll, executable: false },
    { name: "Townsfolk/README.txt", data: crlf(read("release", "README.txt")), executable: false },
    { name: "Townsfolk/start-brain.cmd", data: crlf(read("release", "start-brain.cmd")), executable: false },
    { name: "Townsfolk/start-brain.sh", data: read("release", "start-brain.sh"), executable: true },
    { name: "Townsfolk/brain/start.mjs", data: read("brain", "start.mjs"), executable: false },
    { name: "Townsfolk/brain/package.json", data: read("brain", "package.json"), executable: false },
    ...sourceFiles(join(root, "brain", "src")).map((f) => ({ name: `Townsfolk/brain/src/${f}`, data: read("brain", "src", ...f.split("/")), executable: false })),
  ];

  mkdirSync(join(root, "dist"), { recursive: true });
  const out = join(root, "dist", `townsfolk-v${version}.zip`);
  writeFileSync(out, zip(entries));
  console.log(`wrote ${out}`);
  for (const e of entries) console.log(`  ${e.name}  ${e.data.length} bytes`);
  try {
    console.log(`release smoke: unzipped brain answered /v1/health ${await smokeZip(out)}`);
  } catch (err) {
    unlinkSync(out);
    console.error(`release refused, zip deleted: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();

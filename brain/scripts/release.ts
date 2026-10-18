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
//   Townsfolk/brain/start.mjs, package.json, src/*.ts

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

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

type Entry = { name: string; data: Buffer; executable: boolean };

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

const crlf = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");

function main(): void {
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
    ...readdirSync(join(root, "brain", "src"))
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => ({ name: `Townsfolk/brain/src/${f}`, data: read("brain", "src", f), executable: false })),
  ];

  mkdirSync(join(root, "dist"), { recursive: true });
  const out = join(root, "dist", `townsfolk-v${version}.zip`);
  writeFileSync(out, zip(entries));
  console.log(`wrote ${out}`);
  for (const e of entries) console.log(`  ${e.name}  ${e.data.length} bytes`);
}

if (import.meta.main) main();

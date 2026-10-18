// Starts the brain. Plain JavaScript on purpose: a Node older than 24 cannot load the .ts
// files at all, so the version check has to run before src/main.ts is imported.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(`townsfolk brain needs Node.js 24 or newer; this is Node ${process.versions.node}.`);
  console.error("Install the current LTS from https://nodejs.org, then open a new window and start the brain again.");
  process.exit(1);
}
await import("./src/main.ts");

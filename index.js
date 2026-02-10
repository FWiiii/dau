import { existsSync } from "node:fs";
import path from "node:path";

const cliEntrypoint = path.resolve("./dist/cli.js");

if (!existsSync(cliEntrypoint)) {
  console.error("dist/cli.js not found. Please run: pnpm build");
  process.exit(1);
}

if (!process.argv[2]) {
  const mode = (process.env.APP_MODE ?? "").trim().toLowerCase();
  const defaultCommand = mode === "daemon" ? "sync:daemon" : "sync:run";
  process.argv.splice(2, 0, defaultCommand);
}

await import(cliEntrypoint);

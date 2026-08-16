import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Loads the dev .env before anything reads process.env. Resolved from this file,
// not the cwd: `npm run dev` runs the script with cwd=server/, so a repo-root
// .env would otherwise be invisible. Real environment variables win over the
// file (node's own env-file semantics), so `DATABASE_URL=... npm run dev` and
// the deployed VM's env_vars keep overriding it.
const here = path.dirname(fileURLToPath(import.meta.url));

const explicit = process.env.FASTCAR_ENV_FILE;
if (explicit) {
  process.loadEnvFile(path.resolve(explicit));
} else {
  const candidates = [
    path.resolve(here, "../../.env"), // repo root
    path.resolve(here, "../.env"), // server/
  ];
  const found = candidates.find((f) => fs.existsSync(f));
  if (found) process.loadEnvFile(found);
}

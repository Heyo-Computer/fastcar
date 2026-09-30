import fs from "node:fs";

/**
 * The system Chromium (installed in the VM image) used via playwright-core —
 * no browser download at runtime. Resolution order: FASTCAR_CHROMIUM_PATH,
 * then well-known install paths.
 */
const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

export function findChromium(): string | undefined {
  const explicit = process.env.FASTCAR_CHROMIUM_PATH?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  return CHROMIUM_CANDIDATES.find((p) => fs.existsSync(p));
}

/**
 * Chromium's sandbox needs privileges the Firecracker guest's root user
 * deliberately lacks; the VM is single-tenant, so run without it.
 */
export const CHROMIUM_ARGS = ["--no-sandbox"];

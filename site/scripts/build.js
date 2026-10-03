/**
 * fastcar site — build script
 *
 * Copies the static source (HTML, CSS, JS) into dist/ and validates that the
 * expected files are present. No bundler, no transpilation — the site is
 * plain HTML/CSS/JS, so "building" is just a verified copy.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// Files that must end up in dist/ (relative to the site/ root).
const REQUIRED = [
    "index.html",
    "404.html",
    "styles/site.css",
    "scripts/main.js",
    "package.json",
    "README.md",
];

const cleanOnly = process.argv.includes("--clean-only");

if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
}

if (cleanOnly) {
    console.log("Cleaned → site/dist/ (removed)");
    process.exit(0);
}

fs.mkdirSync(DIST, { recursive: true });

let missing = 0;
for (const rel of REQUIRED) {
    const src = path.join(ROOT, rel);
    const dest = path.join(DIST, rel);
    if (!fs.existsSync(src)) {
        console.error("  ✗ missing source: " + rel);
        missing++;
        continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log("  ✓ " + rel);
}

if (missing) {
    console.error("\nBuild failed: " + missing + " missing file(s).");
    process.exit(1);
}

console.log("\nBuild complete → site/dist/");

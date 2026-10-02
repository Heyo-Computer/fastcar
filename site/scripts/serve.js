/**
 * fastcar site — local preview server
 *
 * A tiny zero-dependency static file server for site/dist/. Serves index.html
 * for "/" and falls back to 404.html for unknown paths (so client-side
 * exploration and deep links land on the 404 page instead of a bare error).
 *
 * Usage: npm run serve   (after npm run build)
 *        PORT=8080 npm run serve
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

function send(res, status, file, type) {
    fs.readFile(file, function (err, data) {
        if (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("500 — internal error");
            return;
        }
        res.writeHead(status, { "Content-Type": type });
        res.end(data);
    });
}

const server = http.createServer(function (req, res) {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

    let file = path.join(DIST, urlPath);
    // Guard against path traversal.
    if (!file.startsWith(DIST)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("403 — forbidden");
        return;
    }

    // Serve a directory's index.html if present.
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, "index.html");
    }

    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        send(res, 200, file, MIME[ext] || "application/octet-stream");
        return;
    }

    // Fall back to the 404 page for anything unknown.
    const notFound = path.join(DIST, "404.html");
    if (fs.existsSync(notFound)) {
        send(res, 404, notFound, "text/html; charset=utf-8");
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 — not found");
});

server.listen(PORT, function () {
    console.log("fastcar site preview → http://localhost:" + PORT);
    console.log("serving: " + DIST);
});

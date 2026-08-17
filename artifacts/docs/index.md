# Fastcar Documentation

> Documentation hub for **fastcar** 🏎️ — a multi-vendor agent harness built on
> the [Pi coding agent SDK](https://pi.dev).

Fastcar runs a **conductor** agent (InceptionLabs **Mercury**) that routes work
to subagents on **OpenRouter**, with a Hermes-style dark web UI,
Postgres-backed threads and memories, a plan → approve → act workflow, blocking
clarifying questions, Tavily web search, and voice prompts via speech-to-text.

This directory holds the source Markdown for the rendered documentation site.
Every `.md` file here is converted to HTML by the
[`render-artifacts`](../../.github/workflows/render-artifacts.yml) GitHub
Actions workflow and published to GitHub Pages under
`https://heyo-computer.github.io/fastcar/`.

## Table of Contents

- [Index](./index.md) — this page (project overview + nav)
- [Architecture](./architecture.md) — system design, model routing, and the
  source-of-truth split
- [API Spec](./api-spec.md) — REST and WebSocket surface area

## More

- [README](../../README.md) — top-level project README (setup, env vars, usage)
- [Deploy guide](../../deploy/README.md) — Firecracker microVM deployment

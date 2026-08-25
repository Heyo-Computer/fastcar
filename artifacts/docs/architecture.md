# Architecture

> _Placeholder._ This document will describe the Fastcar system architecture.

## Overview

Fastcar is a multi-vendor agent harness built on the
[Pi coding agent SDK](https://pi.dev) (`@earendil-works/pi-coding-agent`).

## Sections (to be filled in)

- Conductor session (Pi `AgentSession`, Mercury 2.5 with a settings-controlled `reasoning_effort`)
- Subagent manager (in-process Pi sessions on OpenRouter)
- Thread state machine (`idle` / `running` / `awaiting_input` /
  `awaiting_approval`)
- Model routing (shared `ModelRuntime`, InceptionLabs + OpenRouter providers)
- Source-of-truth split (Pi JSONL sessions vs. Postgres `events`)

_See the top-level [README](../../README.md) for the current architecture
diagram and narrative until this page is fleshed out._

import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * Minimal identity model for permission checks (Features 1–3).
 *
 * fastcar ships single-user by default: when `FASTCAR_ADMIN_TOKEN` is unset,
 * every caller is treated as an admin and thread ownership is not enforced
 * (the dev/CI flow has no real auth). When the token is set, callers identify
 * themselves with either `Authorization: Bearer <token>` (admin) or
 * `X-Owner-Id: <id>` (a regular user); admin callers are always allowed.
 */
export interface Caller {
  /** Resolved owner id, or null when anonymous. */
  ownerId: string | null;
  isAdmin: boolean;
}

export function callerFromRequest(cfg: Config, req: FastifyRequest): Caller {
  const auth = req.headers.authorization ?? "";
  const ownerIdHeader = req.headers["x-owner-id"];
  const ownerId =
    (Array.isArray(ownerIdHeader) ? ownerIdHeader[0] : ownerIdHeader) ?? null;

  // No admin token configured => single-user dev mode: everyone is an admin.
  if (!cfg.adminToken) {
    return { ownerId: ownerIdHeader ? ownerId : cfg.defaultOwner, isAdmin: true };
  }

  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer && bearer === cfg.adminToken) {
    return { ownerId: ownerIdHeader ? ownerId : cfg.defaultOwner, isAdmin: true };
  }
  return { ownerId: ownerIdHeader ? ownerId : null, isAdmin: false };
}

// Deliberately minimal app access control: a single shared secret (APP_TOKEN).
// Accepted as a Bearer header, an x-app-token header, or a ?token= query param
// (the query form is needed because browser EventSource cannot set headers).

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function extractToken(req: FastifyRequest): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();

  const x = req.headers["x-app-token"];
  if (typeof x === "string") return x.trim();

  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === "string") return q.trim();

  return "";
}

/** Fastify preHandler. Short-circuits with 401 when the token is wrong/missing. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractToken(req);
  if (!token || !safeEqual(token, config.appToken)) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

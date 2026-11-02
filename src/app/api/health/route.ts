/**
 * Liveness endpoint for the ALB target group health check.
 *
 * This path must be reachable *without* authentication. An ALB health check
 * follows no redirects and carries no session cookie, so if this route sits
 * behind an `authenticate-oidc` action the ALB receives a 302, treats the
 * target as unhealthy, and pulls every task out of service. Phase 3 therefore
 * needs a higher-priority listener rule that forwards /api/health straight to
 * the target group, ahead of the catch-all rule that authenticates.
 *
 * Keep this handler free of dependencies: no auth, no database, no outbound
 * calls. It answers "is the Node process serving requests", nothing more.
 *
 * Note: no `export const dynamic = "force-dynamic"` here. Under
 * `cacheComponents` that route segment config is rejected at build time, and it
 * is unnecessary anyway — an uncached route handler is already dynamic.
 */
export function GET() {
  return Response.json(
    {
      status: "ok",
      service: process.env.SERVICE_NAME ?? "securly-tool-template",
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

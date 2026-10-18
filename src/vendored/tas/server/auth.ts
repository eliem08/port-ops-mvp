/**
 * lib/server/auth.ts
 *
 * Auth / RBAC adapter seam for the API routes.
 *
 * ------------------------------------------------------------------
 * WHAT A REAL PROVIDER MUST IMPLEMENT (production checklist)
 * ------------------------------------------------------------------
 * 1. AuthProvider.getAuthContext(req) must verify a signed credential
 *    (e.g. OIDC/JWT access token) on EVERY request — never trust a
 *    client-supplied header like x-demo-role.
 * 2. Roles must come from the identity provider (token claims or a
 *    directory lookup), not from the request body.
 * 3. Tokens must be validated: signature, issuer, audience, expiry,
 *    and (for logout/revocation) a denylist or short TTL.
 * 4. AuthN failures → 401; AuthZ failures → 403. Never 200 with a
 *    degraded-privilege fallback.
 * 5. All denials and grants of privileged actions go to the audit log.
 *
 * DevMockAuthProvider below implements the SAME interface against a
 * fixed demo operator so routes can be developed and tested without
 * an identity provider. It is CLEARLY NOT production auth:
 * roles are taken from the x-demo-role request header, which any
 * client can set. Do not ship it.
 */

export type Role = "viewer" | "planner" | "approver" | "admin";

export interface AuthContext {
  userId: string;
  roles: Role[];
}

/**
 * Auth provider contract. Any implementation (mock or real) must
 * return the authenticated user's id and roles for the request.
 */
export interface AuthProvider {
  getAuthContext(req: Request): Promise<AuthContext>;
}

const KNOWN_ROLES: Role[] = ["viewer", "planner", "approver", "admin"];

function isRole(v: string): v is Role {
  return (KNOWN_ROLES as string[]).includes(v);
}

/**
 * DevMockAuthProvider — DEMO ONLY, NOT production auth.
 *
 * Returns a fixed demo operator ("demo-operator") whose roles default
 * to ["viewer", "planner"]. A test or demo client may set the
 * `x-demo-role` header to "approver" or "admin" to exercise privileged
 * paths. Because the header is client-controlled, this provider must
 * never be used in production.
 */
export class DevMockAuthProvider implements AuthProvider {
  private readonly userId = "demo-operator";

  async getAuthContext(req: Request): Promise<AuthContext> {
    const raw = req.headers.get("x-demo-role")?.trim().toLowerCase();
    const roles: Role[] = ["viewer", "planner"];
    if (raw && isRole(raw)) {
      if (raw === "admin") {
        return { userId: this.userId, roles: ["admin", "approver", "planner", "viewer"] };
      }
      if (!roles.includes(raw)) roles.push(raw);
    }
    return { userId: this.userId, roles };
  }
}

/** The auth provider wired into the routes (swap for a real one here). */
export const authProvider: AuthProvider = new DevMockAuthProvider();

/** True when the context carries the role (admin implies every role). */
export function hasRole(ctx: AuthContext, role: Role): boolean {
  return ctx.roles.includes("admin") || ctx.roles.includes(role);
}

/**
 * Require a role; returns null when allowed, or the 403 payload to
 * return when denied. The route is responsible for the status code.
 */
export function requireRole(
  ctx: AuthContext,
  role: Role,
): { error: string; requiredRole: Role; roles: Role[] } | null {
  if (hasRole(ctx, role)) return null;
  return {
    error: "forbidden",
    requiredRole: role,
    roles: ctx.roles,
  };
}

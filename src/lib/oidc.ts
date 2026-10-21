// OpenID Connect single sign-on (authorization code flow + PKCE).
// Works with any standards-compliant IdP: Keycloak, Entra ID (Azure AD),
// Okta, Auth0, Google Workspace, Authentik…
//
// Configuration (all server-side env):
//   OIDC_ISSUER          issuer URL (discovery at /.well-known/openid-configuration)
//   OIDC_CLIENT_ID       client id
//   OIDC_CLIENT_SECRET   client secret (confidential client)
//   APP_BASE_URL         public base URL, used for the redirect URI
//   OIDC_ROLE_CLAIM      claim holding groups/roles (dot path; default "roles",
//                        e.g. "realm_access.roles" for Keycloak, "groups")
//   OIDC_ROLE_MAP        JSON { "<idp value>": "<platform role>" }
//   OIDC_DEFAULT_ROLE    role when nothing maps; unset = deny sign-in
//   OIDC_PROVIDER_NAME   label for the login button
//
// Security: state + nonce + PKCE (S256) are bound to a signed, httpOnly,
// 10-minute cookie; the id_token signature is verified against the issuer's
// JWKS with issuer/audience/nonce checks. The platform role is re-derived
// from the IdP on every SSO sign-in, so IdP group changes take effect at the
// next login. Locally disabled accounts stay blocked.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { Role } from "@/contracts";
import { ROLE_RANK } from "./auth";
import { DomainError } from "./errors";

export const OIDC_STATE_COOKIE = "portops_oidc";
export const OIDC_STATE_TTL_SECONDS = 600;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  roleClaim: string;
  roleMap: Record<string, Role>;
  defaultRole: Role | null;
  providerName: string;
}

export function oidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.replace(/\/+$/, "");
  if (!issuer || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  let roleMap: Record<string, Role> = {};
  if (env.OIDC_ROLE_MAP) {
    const raw = JSON.parse(env.OIDC_ROLE_MAP) as Record<string, string>;
    roleMap = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Role.parse(v)]));
  }
  return {
    issuer,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: `${base}/api/auth/oidc/callback`,
    scopes: env.OIDC_SCOPES ?? "openid email profile",
    roleClaim: env.OIDC_ROLE_CLAIM ?? "roles",
    roleMap,
    defaultRole: env.OIDC_DEFAULT_ROLE ? Role.parse(env.OIDC_DEFAULT_ROLE) : null,
    providerName: env.OIDC_PROVIDER_NAME ?? "single sign-on",
  };
}

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { cache: "no-store" });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer?.replace(/\/+$/, "") !== issuer) throw new Error("OIDC discovery issuer mismatch");
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function newAuthRequest() {
  const verifier = b64url(randomBytes(32));
  return {
    state: b64url(randomBytes(16)),
    nonce: b64url(randomBytes(16)),
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
  };
}

export function authorizationUrl(
  cfg: OidcConfig,
  disco: Discovery,
  req: { state: string; nonce: string; challenge: string }
): string {
  const url = new URL(disco.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: req.state,
    nonce: req.nonce,
    code_challenge: req.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function claimAt(claims: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    claims
  );
}

/** Highest platform role granted by the IdP claim, else the default (or null = deny). */
export function mapRole(claims: Record<string, unknown>, cfg: Pick<OidcConfig, "roleClaim" | "roleMap" | "defaultRole">): Role | null {
  const raw = claimAt(claims, cfg.roleClaim);
  const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  let best: Role | null = null;
  for (const v of values) {
    const role = cfg.roleMap[v];
    if (role && (best === null || ROLE_RANK[role] > ROLE_RANK[best])) best = role;
  }
  return best ?? cfg.defaultRole;
}

export async function exchangeCode(
  cfg: OidcConfig,
  disco: Discovery,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const res = await fetchImpl(disco.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(
        `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`
      ).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    }).toString(),
    cache: "no-store",
  });
  if (!res.ok) throw new DomainError(401, "sso_failed", "The identity provider rejected the sign-in.");
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new DomainError(401, "sso_failed", "The identity provider returned no ID token.");
  return body.id_token;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export async function verifyIdToken(
  cfg: OidcConfig,
  disco: Discovery,
  idToken: string,
  nonce: string,
  getKey?: JWTVerifyGetKey
): Promise<JWTPayload> {
  let keys = getKey ?? jwksCache.get(disco.jwks_uri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(disco.jwks_uri));
    jwksCache.set(disco.jwks_uri, keys);
  }
  try {
    const { payload } = await jwtVerify(idToken, keys, { issuer: cfg.issuer, audience: cfg.clientId });
    if (payload.nonce !== nonce) throw new Error("nonce mismatch");
    if (!payload.sub) throw new Error("no subject");
    return payload;
  } catch {
    throw new DomainError(401, "sso_failed", "The identity provider's ID token could not be verified.");
  }
}

/** Find-or-create the local account for an SSO identity; returns its id. */
export function provisionSsoUser(db: DatabaseSync, cfg: OidcConfig, claims: JWTPayload): string {
  const role = mapRole(claims as Record<string, unknown>, cfg);
  if (!role) {
    throw new DomainError(403, "sso_no_role", "Your account has no role in this application. Ask an administrator for access.");
  }
  const subject = `${cfg.issuer}|${claims.sub}`;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  const label =
    (typeof claims.name === "string" && claims.name.trim()) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    email ||
    String(claims.sub);

  const existing = db.prepare("SELECT id, disabled FROM users WHERE external_subject = ?").get(subject) as
    | { id: string; disabled: number }
    | undefined;
  if (existing) {
    if (existing.disabled) throw new DomainError(403, "account_disabled", "This account is disabled.");
    db.prepare("UPDATE users SET role = ?, label = ? WHERE id = ?").run(role, label.slice(0, 100), existing.id);
    return existing.id;
  }
  // Don't silently take over a local password account that shares the email.
  const emailOwner = email ? db.prepare("SELECT id FROM users WHERE email = ?").get(email) : undefined;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users (id, label, role, email, external_subject) VALUES (?, ?, ?, ?, ?)"
  ).run(id, label.slice(0, 100), role, emailOwner ? null : email, subject);
  db.prepare(
    `INSERT INTO audit_events (id, actor_id, action, entity, entity_id, detail_json)
     VALUES (?, ?, 'user.created', 'user', ?, ?)`
  ).run(randomUUID(), id, id, JSON.stringify({ role, via: "oidc" }));
  return id;
}

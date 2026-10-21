// OIDC tests with a locally generated signing key and a fake IdP — no network.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { freshTestDb } from "@/test-utils/route-harness";
import {
  authorizationUrl,
  exchangeCode,
  mapRole,
  newAuthRequest,
  oidcConfig,
  provisionSsoUser,
  verifyIdToken,
  type Discovery,
  type OidcConfig,
} from "./oidc";

const ISSUER = "https://idp.example.com/realms/port";
const DISCO: Discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
};

const cfg: OidcConfig = oidcConfig({
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "port-ops",
  OIDC_CLIENT_SECRET: "s3cret",
  APP_BASE_URL: "https://ops.example.com",
  OIDC_ROLE_CLAIM: "realm_access.roles",
  OIDC_ROLE_MAP: JSON.stringify({ "port-viewers": "operations_viewer", "port-supervisors": "supervisor", "port-admins": "administrator" }),
})!;

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function idToken(claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string } = {}) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? "port-ops")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

let db: DatabaseSync;
beforeEach(() => {
  db = freshTestDb();
});

describe("configuration", () => {
  it("is disabled unless issuer, client id and secret are all set", () => {
    expect(oidcConfig({ OIDC_ISSUER: ISSUER })).toBeNull();
    expect(cfg.redirectUri).toBe("https://ops.example.com/api/auth/oidc/callback");
  });

  it("rejects an OIDC_ROLE_MAP that names an unknown platform role", () => {
    expect(() =>
      oidcConfig({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b", OIDC_ROLE_MAP: '{"g":"superuser"}' })
    ).toThrow();
  });

  it("authorization URL carries state, nonce and an S256 PKCE challenge", () => {
    const req = newAuthRequest();
    const url = new URL(authorizationUrl(cfg, DISCO, req));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(req.challenge);
    expect(url.searchParams.get("state")).toBe(req.state);
    expect(url.searchParams.get("nonce")).toBe(req.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
  });
});

describe("role mapping", () => {
  it("picks the highest mapped role from a nested claim", () => {
    expect(mapRole({ realm_access: { roles: ["port-viewers", "port-supervisors", "other"] } }, cfg)).toBe("supervisor");
  });
  it("denies (null) when nothing maps and no default is configured", () => {
    expect(mapRole({ realm_access: { roles: ["unrelated"] } }, cfg)).toBeNull();
    expect(mapRole({}, cfg)).toBeNull();
  });
  it("falls back to OIDC_DEFAULT_ROLE when configured", () => {
    expect(mapRole({}, { ...cfg, defaultRole: "operations_viewer" })).toBe("operations_viewer");
  });
});

describe("ID token verification", () => {
  it("accepts a correctly signed token with matching issuer, audience and nonce", async () => {
    const t = await idToken({ sub: "abc", nonce: "n1" });
    const claims = await verifyIdToken(cfg, DISCO, t, "n1", jwks);
    expect(claims.sub).toBe("abc");
  });

  it.each([
    ["wrong nonce", { sub: "abc", nonce: "other" }, {}],
    ["wrong audience", { sub: "abc", nonce: "n1" }, { aud: "someone-else" }],
    ["wrong issuer", { sub: "abc", nonce: "n1" }, { iss: "https://evil.example.com" }],
    ["expired", { sub: "abc", nonce: "n1" }, { exp: "-1m" }],
  ])("rejects a token with %s", async (_label, claims, opts) => {
    const t = await idToken(claims, opts);
    await expect(verifyIdToken(cfg, DISCO, t, "n1", jwks)).rejects.toMatchObject({ code: "sso_failed" });
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    const t = await new SignJWT({ sub: "abc", nonce: "n1" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("port-ops")
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verifyIdToken(cfg, DISCO, t, "n1", jwks)).rejects.toMatchObject({ code: "sso_failed" });
  });
});

describe("code exchange", () => {
  it("posts code + PKCE verifier with client_secret_basic and returns the id_token", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id_token: "the-token", access_token: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await exchangeCode(cfg, DISCO, "code-1", "verifier-1", fakeFetch)).toBe("the-token");
    const body = new URLSearchParams(String(seen!.init.body));
    expect(seen!.url).toBe(DISCO.token_endpoint);
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("port-ops:s3cret").toString("base64")}`);
  });

  it("maps an IdP error to sso_failed", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(cfg, DISCO, "c", "v", fakeFetch)).rejects.toMatchObject({ code: "sso_failed" });
  });
});

describe("provisioning", () => {
  const claims = (roles: string[], extra: Record<string, unknown> = {}) => ({
    sub: "user-123",
    email: "Karim@Port.example",
    name: "Karim B.",
    realm_access: { roles },
    ...extra,
  });

  it("creates the account on first sign-in and re-syncs the role on the next", () => {
    const id = provisionSsoUser(db, cfg, claims(["port-viewers"]));
    expect(db.prepare("SELECT role, email, label, password_hash FROM users WHERE id = ?").get(id)).toEqual({
      role: "operations_viewer",
      email: "karim@port.example",
      label: "Karim B.",
      password_hash: null,
    });
    expect(provisionSsoUser(db, cfg, claims(["port-admins"]))).toBe(id);
    expect(db.prepare("SELECT role FROM users WHERE id = ?").get(id)).toEqual({ role: "administrator" });
  });

  it("refuses identities without a mapped role, and locally disabled accounts", () => {
    expect(() => provisionSsoUser(db, cfg, claims([]))).toThrow(/no role/);
    const id = provisionSsoUser(db, cfg, claims(["port-viewers"]));
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(id);
    expect(() => provisionSsoUser(db, cfg, claims(["port-viewers"]))).toThrow(/disabled/);
  });

  it("does not take over a local password account that shares the email", () => {
    db.prepare("INSERT INTO users (id, label, role, email, password_hash) VALUES ('local-1', 'Local', 'planner', 'karim@port.example', 'scrypt$x')").run();
    const id = provisionSsoUser(db, cfg, claims(["port-viewers"]));
    expect(id).not.toBe("local-1");
    expect(db.prepare("SELECT role FROM users WHERE id = 'local-1'").get()).toEqual({ role: "planner" });
  });
});

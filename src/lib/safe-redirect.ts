// Post-login redirect targets come from the query string, so they must be
// confined to same-origin paths (no "//evil.com", no "https://…", no "\").

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (raw.startsWith("/login") || raw.startsWith("/api/")) return "/";
  return raw;
}

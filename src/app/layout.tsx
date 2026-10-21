import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, hasRole } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { appName, demoDataPresent } from "@/lib/deployment";
import { UserChip } from "@/components/user-chip";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: appName(),
    description:
      "Port operations intelligence: truck appointments, gate verification, berth planning and operations simulation.",
  };
}

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/appointments", label: "Appointments" },
  { href: "/gate", label: "GateWatch" },
  { href: "/planning", label: "Planning" },
  { href: "/simulate", label: "Simulator" },
];

const ADMIN_NAV = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/settings", label: "Settings" },
];

// Pages reachable without a session, and pages a restricted (setup-pending)
// session may still open.
const PUBLIC_PATHS = ["/login"];
const SETUP_PATHS = ["/account"];

const startsWithAny = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(p + "/"));

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") ?? "/";
  const session = await getSession();

  // Authoritative page guard: the middleware only checks the cookie
  // signature; here revoked/expired sessions and disabled users are caught.
  if (!startsWithAny(pathname, PUBLIC_PATHS)) {
    if (!session) redirect(pathname === "/" ? "/login" : `/login?next=${encodeURIComponent(pathname)}`);
    if (session.restricted && !startsWithAny(pathname, SETUP_PATHS)) redirect("/account");
    if (startsWithAny(pathname, ["/admin"]) && !hasRole(session.role, "administrator")) redirect("/");
  }

  const synthetic = demoDataPresent(getDb());
  const name = appName();

  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        {synthetic && (
          <div
            role="banner"
            className="border-b-4 border-warn bg-ink px-4 py-2.5 text-center"
            aria-label="Synthetic data notice"
          >
            <p className="text-sm font-bold tracking-wide text-white">
              DEMO — SYNTHETIC DATA
              <span className="ml-3 font-normal text-white/80">
                This database contains generated demonstration records, not real port data.
              </span>
            </p>
          </div>
        )}

        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
              <span className="mr-3 text-sm font-bold text-ink">{name}</span>
              {session && !session.restricted &&
                NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded px-3 py-1.5 text-sm font-medium text-slate2 hover:bg-paper hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              {session && !session.restricted && hasRole(session.role, "administrator") && (
                <>
                  <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
                  {ADMIN_NAV.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="rounded px-3 py-1.5 text-sm font-medium text-slate2 hover:bg-paper hover:text-ink"
                    >
                      {item.label}
                    </Link>
                  ))}
                </>
              )}
            </nav>
            {session && <UserChip label={session.label} role={session.role} />}
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>

        <footer className="mt-10 border-t border-line bg-white">
          <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted">
            <p>
              {name} · Decision support for port operations. Automated outcomes
              remain subject to the human-review policy configured by your
              administrator; every action is recorded in the audit trail.
            </p>
            {synthetic && (
              <p className="mt-1">
                Records tagged <span className="font-mono">[SYNTHETIC DEMO DATA]</span> are generated
                for demonstration. Gate scans in the demo are simulated, and simulator
                results are illustrative until calibrated against your operational data.
              </p>
            )}
          </div>
        </footer>
      </body>
    </html>
  );
}

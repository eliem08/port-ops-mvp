import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { UserChip } from "@/components/user-chip";
import "./globals.css";

export const metadata: Metadata = {
  title: "Port Operations Intelligence — Demo",
  description:
    "Demo of a port operations intelligence platform. All data is synthetic; not a production system.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/appointments", label: "Appointments" },
  { href: "/gate", label: "GateWatch" },
];

const DISABLED_NAV = [
  { label: "Planning", note: "Next slice" },
  { label: "Simulator", note: "Next slice" },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        {/* Permanent, prominent DEMO banner — every page, always visible */}
        <div
          role="banner"
          className="border-b-4 border-warn bg-ink px-4 py-2.5 text-center"
          aria-label="Demo environment warning"
        >
          <p className="text-sm font-bold tracking-wide text-white">
            DEMO — SYNTHETIC DATA
            <span className="ml-3 font-normal text-white/80">
              Not a production system. No real port, ANP, or terminal data.
            </span>
          </p>
        </div>

        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
              <span className="mr-3 text-sm font-bold text-ink">
                Port Operations <span className="text-muted">Intelligence</span>
              </span>
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded px-3 py-1.5 text-sm font-medium text-slate2 hover:bg-paper hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
              {DISABLED_NAV.map((item) => (
                <span
                  key={item.label}
                  title={item.note}
                  aria-disabled="true"
                  className="cursor-not-allowed rounded px-3 py-1.5 text-sm text-muted/60"
                >
                  {item.label}
                  <span className="ml-1 rounded border border-line bg-paper px-1.5 py-0.5 text-[11px]">
                    {item.note}
                  </span>
                </span>
              ))}
            </nav>
            {session && <UserChip label={session.label} role={session.role} />}
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>

        <footer className="mt-10 border-t border-line bg-white">
          <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted">
            <p className="font-medium text-ink">Limitations of this demo</p>
            <p className="mt-1">
              All records, metrics, scans, and decisions shown here are synthetic
              demo data generated for illustration. Scans are simulated (no real
              cameras, no real OCR). Authentication is a demo session cookie, not
              a production identity provider. Nothing on this screen represents
              real ANP, Marsa Maroc, or port-terminal data.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

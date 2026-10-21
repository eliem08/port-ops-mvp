// Bootstrap an administrator account on a fresh installation.
// Usage: ADMIN_EMAIL=ops-admin@example.com [ADMIN_NAME="Ops Admin"] [ADMIN_PASSWORD=…] npm run user:create-admin
// Without ADMIN_PASSWORD a random temporary password is generated and printed
// once. The account must change it at first sign-in (and enroll MFA when the
// administrator role requires it — the default).

import { randomBytes } from "node:crypto";
import { getDb } from "./client";
import { createUser } from "../accounts";

function main() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) {
    console.error("ADMIN_EMAIL is required, e.g. ADMIN_EMAIL=ops-admin@example.com npm run user:create-admin");
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(15).toString("base64url");
  const user = createUser(getDb(), "system:bootstrap", {
    email,
    label: process.env.ADMIN_NAME ?? "Administrator",
    role: "administrator",
    password,
  });
  console.log(`created administrator ${user.email} (${user.id})`);
  if (!process.env.ADMIN_PASSWORD) console.log(`temporary password (shown once): ${password}`);
  console.log("They must change this password at first sign-in.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

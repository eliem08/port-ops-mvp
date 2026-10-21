// User administration (administrator only — enforced by the layout guard and
// again by every /api/admin route).

import { getSession } from "@/lib/auth";
import { listUsers } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { Card } from "@/components/ui";
import { CreateUserForm, UserTable } from "./user-admin";

export default async function AdminUsersPage() {
  const session = await getSession();
  const users = listUsers(getDb());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Users</h1>
        <p className="text-sm text-muted">
          {users.length} account(s). New accounts must change their initial password at first sign-in.
        </p>
      </div>
      <Card title="Accounts">
        <UserTable users={users} selfId={session?.userId ?? ""} />
      </Card>
      <Card title="Create account">
        <CreateUserForm />
      </Card>
    </div>
  );
}

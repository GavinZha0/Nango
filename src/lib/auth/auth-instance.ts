import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin as adminPlugin } from "better-auth/plugins";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  UserTable,
  SessionTable,
  AccountTable,
  VerificationTable,
} from "@/lib/db/schema";
import { count, eq, isNull } from "drizzle-orm";

// Cache for first-user check — once false, stays false
let isFirstUserCache: boolean | null = null;

export async function getIsFirstUser(): Promise<boolean> {
  if (isFirstUserCache === false) return false;
  try {
    // Count active (not soft-deleted) users only.
    const result = await db
      .select({ c: count() })
      .from(UserTable)
      .where(isNull(UserTable.deletedAt));
    const isFirst = Number(result[0].c) === 0;
    if (!isFirst) isFirstUserCache = false;
    return isFirst;
  } catch {
    isFirstUserCache = false;
    return false;
  }
}

const options = {
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_BASE_URL,

  plugins: [
    adminPlugin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
    nextCookies(),
  ],

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: UserTable,
      session: SessionTable,
      account: AccountTable,
      verification: VerificationTable,
    },
  }),

  // Expose custom user fields so they appear in session.user on the client
  user: {
    additionalFields: {
      org: {
        type: "string",
        required: false,
        input: true,
      },
      imAccounts: {
        type: "string", // stored as jsonb, serialised to string for better-auth transport
        required: false,
        input: true,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user: Record<string, unknown>) => {
          const isFirstUser = await getIsFirstUser();
          const role = isFirstUser ? "admin" : "user";
          return { data: { ...user, role } };
        },
        after: async (user: Record<string, unknown>) => {
          // Seed the per-user artifact tree (Charts / Reports / Code /
          // Images / HTML / PPT root folders). Idempotent — safe to
          // call even if the migration backfill already provisioned
          // this user. Failure here must not block sign-up: log and
          // continue. If the seed fails, the user will see an empty
          // artifact tree until `seedArtifactCategoriesForUser` is
          // re-invoked manually (admin tooling) — there is no
          // server-side self-heal on the save path today.
          // @see docs/artifact-dashboard-migration.md §4.1.2
          const userId = typeof user.id === "string" ? user.id : null;
          if (!userId) return;
          try {
            const { seedArtifactCategoriesForUser } = await import(
              "@/lib/artifacts/service"
            );
            await seedArtifactCategoriesForUser(userId);
          } catch (err) {
            console.warn(
              `[auth] artifact category seed failed for user ${userId}:`,
              err,
            );
          }
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
  },

  session: {
    // Cache session in cookie for 1 hour to reduce DB queries.
    // Disabled = every request hits database; Enabled = faster but stale data possible.
    cookieCache: { enabled: true, maxAge: 60 * 60 },
    // Session expires after 7 days of inactivity (user must re-login).
    expiresIn: 60 * 60 * 24 * 7,
    // Refresh session cookie every 24 days (extends expiry window).
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    useSecureCookies:
      process.env.NO_HTTPS === "1"
        ? false
        : process.env.NODE_ENV === "production",
    database: { generateId: false },
  },
} satisfies BetterAuthOptions;

export const auth = betterAuth(options);

export async function getSession() {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });
    if (!session) return null;
    // Reject soft-deleted users; their cookie may still be valid until
    // cookie cache expiry, but we drop them on every request as a hard
    // gate. See docs/rbac.md §4.
    const [row] = await db
      .select({ deletedAt: UserTable.deletedAt })
      .from(UserTable)
      .where(eq(UserTable.id, session.user.id))
      .limit(1);
    if (!row || row.deletedAt !== null) return null;
    return session;
  } catch {
    return null;
  }
}

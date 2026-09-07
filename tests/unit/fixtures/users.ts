/**
 * Shared test fixtures and factory helpers for Users and Sessions.
 */

export type UserRole = "admin" | "editor" | "user";

export interface MockUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt?: Date;
  updatedAt?: Date;
  image?: string | null;
  emailVerified?: boolean;
}

export interface MockSession {
  user: MockUser;
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token?: string;
    createdAt?: Date;
    updatedAt?: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}

export const ADMIN_USER: MockUser = {
  id: "user-admin-1",
  email: "admin@example.com",
  name: "Admin User",
  role: "admin",
};

export const EDITOR_USER: MockUser = {
  id: "user-editor-1",
  email: "editor@example.com",
  name: "Editor User",
  role: "editor",
};

export const REGULAR_USER: MockUser = {
  id: "user-reg-1",
  email: "user@example.com",
  name: "Regular User",
  role: "user",
};

let userSeq = 1;

/**
 * Creates a MockUser with sensible defaults, allowing selective overrides.
 */
export function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  const seq = userSeq++;
  return {
    id: `user-${seq}`,
    email: `user-${seq}@example.com`,
    name: `User ${seq}`,
    role: "user",
    ...overrides,
  };
}

/**
 * Creates a mock session object matching Better-Auth's session contract.
 */
export function createMockSession(user: Partial<MockUser> | MockUser = EDITOR_USER): MockSession {
  const fullUser: MockUser = {
    id: user.id ?? "user-editor-1",
    email: user.email ?? "editor@example.com",
    name: user.name ?? "Editor User",
    role: user.role ?? "editor",
    ...user,
  };

  return {
    user: fullUser,
    session: {
      id: `session-${fullUser.id}`,
      userId: fullUser.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  };
}

/**
 * Test user constants for E2E tests.
 *
 * The first user to sign up becomes admin automatically (via better-auth
 * databaseHooks). Subsequent users get the "user" role.
 */

export const TEST_USERS = {
  admin: {
    name: "Test Admin",
    email: "admin@test-e2e.local",
    password: "TestAdmin123!",
  },
  regular: {
    name: "Test User",
    email: "user@test-e2e.local",
    password: "TestUser123!",
  },
} as const;

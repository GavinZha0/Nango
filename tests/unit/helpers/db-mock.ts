/**
 * Standardized Drizzle ORM mock factories for Vitest unit tests.
 *
 * Provides two levels of mocking:
 * 1. `createDbStub`: Lightweight stub where each chainable method returns the mock chain.
 * 2. `createDrizzleMock`: Fully fluent thenable mock with `$resolveWith` and `$enqueue` queueing.
 */

import { vi, type Mock } from "vitest";

export interface MockDrizzleChain {
  $dynamic: Mock;
  from: Mock;
  where: Mock;
  orderBy: Mock;
  limit: Mock;
  offset: Mock;
  groupBy: Mock;
  having: Mock;
  leftJoin: Mock;
  innerJoin: Mock;
  rightJoin: Mock;
  set: Mock;
  values: Mock;
  onConflictDoUpdate: Mock;
  onConflictDoNothing: Mock;
  returning: Mock;
  execute: Mock;
  then: (onfulfilled?: ((value: unknown) => unknown) | null, onrejected?: ((reason: unknown) => unknown) | null) => Promise<unknown>;
}

export interface MockDrizzleDb {
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  transaction: Mock & (<T = unknown>(cb: (tx: MockDrizzleDb) => Promise<T>) => Promise<T>);
  _chain: MockDrizzleChain;
  /** Sets the resolved value for subsequent query chains. */
  $resolveWith: (data: unknown) => void;
  /** Enqueues a sequence of results consumed one-by-one by subsequent query executions. */
  $enqueue: (...dataRows: unknown[][]) => void;
  /** Clears DB-specific mock calls and the FIFO queue without affecting global mocks. */
  $reset: () => void;
}

export interface MockDbStub {
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  transaction: Mock & (<T = unknown>(callback: (tx: MockDbStub) => Promise<T>) => Promise<T>);
  _chain: Record<string, Mock>;
}

/**
 * Creates a lightweight stub of the db query builder.
 * Useful for tests that only care that db operations are called without needing custom data pipelines.
 */
export function createDbStub(): MockDbStub {
  const chain: Record<string, Mock> = {
    $dynamic: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    groupBy: vi.fn(),
    having: vi.fn(),
    leftJoin: vi.fn(),
    innerJoin: vi.fn(),
    rightJoin: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn(),
    returning: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue([]),
  };

  for (const key of Object.keys(chain)) {
    if (key !== "returning" && key !== "execute") {
      chain[key].mockReturnValue(chain);
    }
  }

  const stub: MockDbStub = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    transaction: vi.fn(async (callback: (tx: MockDbStub) => Promise<unknown>) => callback(stub)) as unknown as Mock & (<T = unknown>(callback: (tx: MockDbStub) => Promise<T>) => Promise<T>),
    _chain: chain,
  };

  return stub;
}

/**
 * Creates a robust fluent mock of Drizzle ORM that supports arbitrary chaining order,
 * async resolution via thenable interface, .returning(), and sequential queueing.
 */
export function createDrizzleMock(initialData: unknown = []): MockDrizzleDb {
  let defaultResult = initialData;
  const resultQueue: unknown[] = [];

  function getNextResult(): unknown {
    if (resultQueue.length > 0) {
      return resultQueue.shift();
    }
    return defaultResult;
  }

  const chain: MockDrizzleChain = {
    $dynamic: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    groupBy: vi.fn(),
    having: vi.fn(),
    leftJoin: vi.fn(),
    innerJoin: vi.fn(),
    rightJoin: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn(),
    returning: vi.fn().mockImplementation(() => Promise.resolve(getNextResult())),
    execute: vi.fn().mockImplementation(() => Promise.resolve(getNextResult())),
    then: (onfulfilled, onrejected) => {
      return Promise.resolve(getNextResult()).then(onfulfilled, onrejected);
    },
  };

  // Self-chaining for all intermediate builder calls
  const chainMethods: Array<keyof Omit<MockDrizzleChain, "returning" | "execute" | "then">> = [
    "$dynamic",
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "groupBy",
    "having",
    "leftJoin",
    "innerJoin",
    "rightJoin",
    "set",
    "values",
    "onConflictDoUpdate",
    "onConflictDoNothing",
  ];

  for (const method of chainMethods) {
    (chain[method] as Mock).mockReturnValue(chain);
  }

  const db: MockDrizzleDb = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    transaction: vi.fn(async (cb: (tx: MockDrizzleDb) => Promise<unknown>) => cb(db)) as unknown as Mock & (<T = unknown>(cb: (tx: MockDrizzleDb) => Promise<T>) => Promise<T>),
    _chain: chain,
    $resolveWith: (data: unknown) => {
      defaultResult = data;
    },
    $enqueue: (...dataRows: unknown[][]) => {
      resultQueue.push(...dataRows);
    },
    $reset: () => {
      resultQueue.length = 0;
      defaultResult = initialData;

      // CONTRACT: Reset only db-specific mocks, avoiding global vi.clearAllMocks() side-effects
      for (const method of chainMethods) {
        (chain[method] as Mock).mockClear();
        (chain[method] as Mock).mockReturnValue(chain);
      }
      chain.returning.mockClear();
      chain.returning.mockImplementation(() => Promise.resolve(getNextResult()));
      chain.execute.mockClear();
      chain.execute.mockImplementation(() => Promise.resolve(getNextResult()));

      db.select.mockClear();
      db.select.mockReturnValue(chain);
      db.insert.mockClear();
      db.insert.mockReturnValue(chain);
      db.update.mockClear();
      db.update.mockReturnValue(chain);
      db.delete.mockClear();
      db.delete.mockReturnValue(chain);
      db.transaction.mockClear();
    },
  };

  return db;
}

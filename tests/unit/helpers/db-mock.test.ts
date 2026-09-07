import { describe, it, expect, vi } from "vitest";
import { createDbStub, createDrizzleMock } from "./db-mock";

describe("db-mock helpers", () => {
  describe("createDbStub", () => {
    it("provides fluent chainable query builder methods", () => {
      const stub = createDbStub();
      const chain = stub.select().from("table").where("cond").limit(10).orderBy("id");
      expect(chain).toBe(stub._chain);
      expect(stub.select).toHaveBeenCalled();
      expect(stub._chain.from).toHaveBeenCalledWith("table");
      expect(stub._chain.where).toHaveBeenCalledWith("cond");
      expect(stub._chain.limit).toHaveBeenCalledWith(10);
      expect(stub._chain.orderBy).toHaveBeenCalledWith("id");
    });

    it("resolves returning and execute to empty arrays by default", async () => {
      const stub = createDbStub();
      const resReturning = await stub.insert().values({}).returning();
      const resExecute = await stub.delete().where("id = 1").execute();
      expect(resReturning).toEqual([]);
      expect(resExecute).toEqual([]);
    });

    it("supports transaction callback execution", async () => {
      const stub = createDbStub();
      const txResult = await stub.transaction(async (tx: unknown) => {
        return tx;
      });
      expect(txResult).toBe(stub);
    });
  });

  describe("createDrizzleMock", () => {
    it("resolves default query results via thenable directly", async () => {
      const defaultRows = [{ id: "row-1", name: "Alpha" }];
      const db = createDrizzleMock(defaultRows);

      const rows = await db.select().from("users").where("active = true");
      expect(rows).toEqual(defaultRows);
      expect(db.select).toHaveBeenCalled();
      expect(db._chain.from).toHaveBeenCalledWith("users");
    });

    it("supports .returning() and .execute() async resolution", async () => {
      const inserted = [{ id: "10", title: "New Item" }];
      const db = createDrizzleMock(inserted);

      const result = await db.insert().values({ title: "New Item" }).returning();
      expect(result).toEqual(inserted);
    });

    it("supports $resolveWith to change default return data", async () => {
      const db = createDrizzleMock([{ id: "1" }]);
      db.$resolveWith([{ id: "2", status: "updated" }]);

      const rows = await db.select().from("items");
      expect(rows).toEqual([{ id: "2", status: "updated" }]);
    });

    it("supports $enqueue for sequential FIFO execution results", async () => {
      const db = createDrizzleMock([{ fallback: true }]);
      db.$enqueue(
        [{ step: 1 }],
        [{ step: 2 }],
      );

      const res1 = await db.select().from("table");
      const res2 = await db.select().from("table");
      const res3 = await db.select().from("table");

      expect(res1).toEqual([{ step: 1 }]);
      expect(res2).toEqual([{ step: 2 }]);
      expect(res3).toEqual([{ fallback: true }]);
    });

    it("resets call counts and queues without invoking global vi.clearAllMocks", async () => {
      const otherMock = vi.fn();
      otherMock("call-1");

      const db = createDrizzleMock([{ id: 1 }]);
      db.$enqueue([{ id: 2 }]);
      await db.select().from("table");

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(otherMock).toHaveBeenCalledTimes(1);

      db.$reset();

      // DB mocks are reset
      expect(db.select).toHaveBeenCalledTimes(0);
      expect(db._chain.from).toHaveBeenCalledTimes(0);

      // Global otherMock must NOT be cleared by db.$reset()
      expect(otherMock).toHaveBeenCalledTimes(1);

      // Queue was cleared, so it returns initial data
      const afterReset = await db.select().from("table");
      expect(afterReset).toEqual([{ id: 1 }]);
    });

    it("supports groupBy and having chain methods", async () => {
      const db = createDrizzleMock([{ count: 5 }]);
      const rows = await db.select().from("orders").groupBy("userId").having("count > 1");
      expect(rows).toEqual([{ count: 5 }]);
      expect(db._chain.groupBy).toHaveBeenCalledWith("userId");
      expect(db._chain.having).toHaveBeenCalledWith("count > 1");
    });
  });
});

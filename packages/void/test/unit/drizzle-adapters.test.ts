import { describe, expect, it, vi } from "vitest";

const { drizzleArktypeMock, drizzleValibotMock, drizzleZodMock } = vi.hoisted(() => ({
  drizzleArktypeMock: {
    createInsertSchema: vi.fn(),
    createSelectSchema: vi.fn(),
    createUpdateSchema: vi.fn(),
  },
  drizzleValibotMock: {
    createInsertSchema: vi.fn(),
    createSelectSchema: vi.fn(),
    createUpdateSchema: vi.fn(),
  },
  drizzleZodMock: {
    createInsertSchema: vi.fn(),
    createSelectSchema: vi.fn(),
    createUpdateSchema: vi.fn(),
  },
}));

vi.mock("drizzle-zod", () => drizzleZodMock);
vi.mock("drizzle-valibot", () => drizzleValibotMock);
vi.mock("drizzle-arktype", () => drizzleArktypeMock);

import * as drizzleArktype from "../../src/runtime/drizzle-arktype";
import * as drizzleValibot from "../../src/runtime/drizzle-valibot";
import * as drizzleZod from "../../src/runtime/drizzle-zod";

describe("drizzle validator runtimes", () => {
  it("re-exports drizzle-zod", () => {
    expect(drizzleZod.createInsertSchema).toBe(drizzleZodMock.createInsertSchema);
    expect(drizzleZod.createSelectSchema).toBe(drizzleZodMock.createSelectSchema);
    expect(drizzleZod.createUpdateSchema).toBe(drizzleZodMock.createUpdateSchema);
  });

  it("re-exports drizzle-valibot", () => {
    expect(drizzleValibot.createInsertSchema).toBe(drizzleValibotMock.createInsertSchema);
    expect(drizzleValibot.createSelectSchema).toBe(drizzleValibotMock.createSelectSchema);
    expect(drizzleValibot.createUpdateSchema).toBe(drizzleValibotMock.createUpdateSchema);
  });

  it("re-exports drizzle-arktype", () => {
    expect(drizzleArktype.createInsertSchema).toBe(drizzleArktypeMock.createInsertSchema);
    expect(drizzleArktype.createSelectSchema).toBe(drizzleArktypeMock.createSelectSchema);
    expect(drizzleArktype.createUpdateSchema).toBe(drizzleArktypeMock.createUpdateSchema);
  });
});

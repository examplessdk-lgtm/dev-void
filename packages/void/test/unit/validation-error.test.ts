import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/pages/validation-error";

describe("ValidationError", () => {
  it("has correct name and message", () => {
    const err = new ValidationError({ name: "required" });
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("Validation failed");
  });

  it("stores errors record", () => {
    const errors = { name: "required", email: "invalid format" };
    const err = new ValidationError(errors);
    expect(err.errors).toEqual(errors);
  });

  it("is an instance of Error", () => {
    const err = new ValidationError({});
    expect(err).toBeInstanceOf(Error);
  });
});

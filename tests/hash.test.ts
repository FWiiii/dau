import { describe, expect, it } from "vitest";

import { makeMediaKey } from "../src/utils/hash.js";

describe("makeMediaKey", () => {
  it("returns stable hash for same input", () => {
    const first = makeMediaKey("123", "https://example.com/a.jpg");
    const second = makeMediaKey("123", "https://example.com/a.jpg");

    expect(first).toBe(second);
  });

  it("returns different hash for different inputs", () => {
    const first = makeMediaKey("123", "https://example.com/a.jpg");
    const second = makeMediaKey("124", "https://example.com/a.jpg");

    expect(first).not.toBe(second);
  });
});


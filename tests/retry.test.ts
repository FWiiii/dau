import { describe, expect, it } from "vitest";

import { withRetry } from "../src/utils/retry.js";

describe("withRetry", () => {
  it("retries and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary failure");
        }
        return "ok";
      },
      { retries: 3, baseDelayMs: 1, factor: 1 },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws after retries exhausted", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("always fail");
        },
        { retries: 1, baseDelayMs: 1, factor: 1 },
      ),
    ).rejects.toThrow("always fail");
  });
});


export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  factor: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= options.retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) {
        break;
      }

      const delay = options.baseDelayMs * Math.pow(options.factor, attempt);
      await sleep(delay);
      attempt += 1;
    }
  }

  throw lastError;
}


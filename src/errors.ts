export class TwitterRateLimitError extends Error {
  readonly hosts: string[];

  constructor(message: string, hosts: string[]) {
    super(message);
    this.name = "TwitterRateLimitError";
    this.hosts = hosts;
  }
}

export function isTwitterRateLimitError(
  error: unknown,
): error is TwitterRateLimitError {
  if (error instanceof TwitterRateLimitError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\(429\)|rate limit/i.test(message);
}

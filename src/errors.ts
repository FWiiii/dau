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
  return error instanceof TwitterRateLimitError;
}

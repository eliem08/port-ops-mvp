// Expected, user-facing failures (validation of business rules, conflicts).
// handleRouteError() turns these into the sanitized { error: { code, message } }
// envelope with their status; anything else stays a generic 500.

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

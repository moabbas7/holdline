/** An error meant for the user: printed without a stack trace. */
export class HoldlineError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'HoldlineError';
  }
}

/** The user declined a confirmation; nothing was changed. */
export class CancelledError extends HoldlineError {
  constructor(message = 'Cancelled. Nothing was changed.') {
    super(message, 130);
    this.name = 'CancelledError';
  }
}

// The ONE way an error's own text reaches the screen.
//
// An error's message is shown to a user only when the error is an instance of
// UserMessageError: the app's own validation and domain refusals, and the
// callable wrappers' domain errors (whose text the server wrote for the
// operator). Everything else — a plain Error, a TypeError, a library error,
// a Firebase error — is mapped by its code to a safe sentence, or replaced
// with the page's fallback. Text that merely LOOKS harmless is not trusted.
//
// The technical-content filter in liveDataErrors.js still runs on trusted
// messages too, as defence in depth: if one ever carries technical detail, it
// is suppressed like any other.

export class UserMessageError extends Error {
  /**
   * @param {string} message  a complete sentence written for the user
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UserMessageError";
    if (typeof code === "string") this.code = code;
  }
}

/** True when this error's own text may be shown to a user. */
export function isUserMessageError(error) {
  return error instanceof UserMessageError;
}

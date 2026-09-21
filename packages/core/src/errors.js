export class BridgeError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorPayload(error) {
  if (error instanceof BridgeError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { error: { code: "internal_error", message: "Internal error" } };
}

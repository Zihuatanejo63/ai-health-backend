export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(message: string) {
  return new AppError(400, "invalid_request", message);
}

export function unauthorized(message = "Authentication required") {
  return new AppError(401, "unauthorized", message);
}

export function forbidden(message = "Access denied") {
  return new AppError(403, "forbidden", message);
}

export function notFound(message = "Not found") {
  return new AppError(404, "not_found", message);
}

export function conflict(message: string) {
  return new AppError(409, "conflict", message);
}

export function tooManyRequests(message = "Too many requests") {
  return new AppError(429, "rate_limited", message);
}

export function internalError(message = "Internal server error") {
  return new AppError(500, "internal_error", message);
}

export function serviceUnavailable(message = "Service temporarily unavailable") {
  return new AppError(503, "service_unavailable", message);
}

export function safeGeminiError(): AppError {
  return serviceUnavailable("AI service temporarily unavailable. Please try again later.");
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return new Response(
      JSON.stringify({
        error: { code: error.code, message: error.message }
      }),
      {
        status: error.status,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }

  console.error("Unhandled error:", error instanceof Error ? error.message : String(error));
  return new Response(
    JSON.stringify({
      error: { code: "internal_error", message: "An unexpected error occurred." }
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    }
  );
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

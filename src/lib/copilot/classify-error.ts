export type ErrorScope = "system" | "session";

export interface ClassifiedError {
  scope: ErrorScope;
  status: number | null;
  message: string;
  rawMessage: string;
}

/**
 * Classifies an error from CopilotKit / AG-UI / AI SDK into either:
 * - "system": Infrastructure failures (401 session expired, 403 forbidden, network offline) -> Toast notification
 * - "session": Session / Model runtime failures (404 model not found, 429 rate limit, 500, etc.) -> In-chat error card
 */
export function classifyError(
  source: { message?: string; code?: string } | Error | unknown,
): ClassifiedError {
  const rawMessage =
    source instanceof Error
      ? source.message
      : typeof source === "object" && source !== null
        ? ((source as { message?: string; code?: string }).message ??
           (source as { message?: string; code?: string }).code ??
           "")
        : String(source ?? "");

  // Match e.g. "HTTP 401: ...", "status 401", "code 401"
  const httpMatch = /(?:HTTP|status|code)\s*:?\s*(\d{3})\b/i.exec(rawMessage);
  const status = httpMatch ? Number(httpMatch[1]) : null;

  // Check for network offline
  const isNetworkOffline =
    /failed to fetch|network error|fetch failed|network request failed/i.test(
      rawMessage,
    );

  if (status === 401) {
    return {
      scope: "system",
      status,
      message: "Your session has expired. Please sign in again.",
      rawMessage,
    };
  }

  if (status === 403) {
    return {
      scope: "system",
      status,
      message: "Access denied. You do not have permission to perform this action.",
      rawMessage,
    };
  }

  if (isNetworkOffline) {
    return {
      scope: "system",
      status: null,
      message: "Network connection lost. Please check your internet connection.",
      rawMessage,
    };
  }

  if (status === 503) {
    return {
      scope: "system",
      status,
      message: "No built-in agents or services are available right now. Please try again in a moment.",
      rawMessage,
    };
  }

  // Model & session level errors -> scope = "session" (e.g. 404 model not found, 429 rate limit, 500, timeout)
  let friendlyMessage = rawMessage;
  if (status === 404) {
    friendlyMessage = rawMessage.includes("model")
      ? rawMessage
      : "The requested agent or resource was not found.";
  } else if (status === 429) {
    friendlyMessage = "Rate limit reached. Please wait a moment before trying again.";
  } else if (!friendlyMessage) {
    friendlyMessage = "Agent execution failed. Please try again.";
  }

  return {
    scope: "session",
    status,
    message: friendlyMessage,
    rawMessage,
  };
}

/**
 * Standardized response helpers for MCP tool results.
 * All tools return TextContent with structured JSON.
 */

interface SuccessResponse {
  success: true;
  data: Record<string, unknown>;
  message: string;
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

type ToolResponse = SuccessResponse | ErrorResponse;

/**
 * `structuredData`, when given, is the same result with fuller data for
 * `structuredContent` (the text stays compact); success and message are shared.
 */
export function successResponse(
  data: Record<string, unknown>,
  message: string,
  structuredData?: Record<string, unknown>
) {
  const response: ToolResponse = { success: true, data, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
    ...(structuredData ? { structuredContent: { success: true, data: structuredData, message } } : {}),
  };
}

export function errorResponse(
  code: string,
  message: string,
  suggestion?: string
) {
  const response: ToolResponse = {
    success: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
  };
}

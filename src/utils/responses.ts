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

export function successResponse(
  data: Record<string, unknown>,
  message: string
) {
  const response: ToolResponse = { success: true, data, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
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

/**
 * Client-side secret redaction for text the MCP passes on from Varity (build
 * error lines, refusal messages). The gateway already redacts what it serves
 * (`public-api-redaction.ts` `redactPublicText` / `redactPublicBuildLine`);
 * this is the second, local pass over the same credential shapes plus common
 * secret formats, and it also removes exact values this process knows are
 * secret (the configured deploy key, values read from a project's `.env`).
 * It keeps ordinary words, so a compiler error stays readable.
 */

const URL_USER = /:\/\/[^:/@]*:/;
/** A URL's password runs to the token's last "@" (gateway rule, per token). */
function redactUrlPasswords(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const at = token.lastIndexOf("@");
    const user = at < 0 ? null : URL_USER.exec(token.slice(0, at));
    return user ? `${token.slice(0, user.index + user[0].length)}[redacted]${token.slice(at)}` : token;
  });
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-private-key]"],
  [/vk_[A-Za-z0-9._-]+/g, "[redacted-key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-token]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/(authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)(\s*[=:]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[redacted]"],
];

/**
 * Redact credentials from `input`. `knownValues` are exact secret strings
 * (removed wherever they occur, longest first); values shorter than 4
 * characters are skipped so a one-letter value cannot blank out the text
 * (accepted gap: such a value is not secret-sized, and the gateway's env
 * validation errors name keys, not values).
 */
export function redactPublicText(input: string, knownValues: readonly string[] = []): string {
  let text = input;
  for (const value of [...knownValues].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join("[redacted]");
  }
  text = redactUrlPasswords(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/** Every string inside a JSON value redacted; keys, numbers and booleans untouched. */
function redactStrings(value: unknown, known: readonly string[]): unknown {
  if (typeof value === "string") return redactPublicText(value, known);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, known));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, known)]));
  }
  return value;
}

/**
 * The one guard for tool results that may echo secret values the MCP just
 * sent (env values from a project's `.env`): every string in the response
 * (message, error, suggestion, data) is passed through `redactPublicText`
 * with those values. Only string fields change, so the result stays valid
 * JSON even when a value is "true" or "3000".
 */
export function withoutValues<T extends { content: Array<{ type: "text"; text: string }> }>(
  response: T,
  values: readonly string[]
): T {
  if (values.length === 0) return response;
  return {
    ...response,
    content: response.content.map((item) => {
      try {
        return { ...item, text: JSON.stringify(redactStrings(JSON.parse(item.text), values), null, 2) };
      } catch {
        return { ...item, text: redactPublicText(item.text, values) };
      }
    }),
  };
}

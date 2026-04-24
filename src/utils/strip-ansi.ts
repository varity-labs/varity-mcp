// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]|\x1b\]\d*;[^\x07]*\x07|\x1b[()][0-9A-Z]|\x1b\[\?[0-9]+[hl]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

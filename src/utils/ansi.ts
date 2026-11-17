/**
 * Terminal escape sequences a local CLI can emit.
 *
 * This is the union of the three copies that previously lived in deploy.ts,
 * deploy-logs.ts and migrate.ts. Two of them shared one pattern; migrate.ts had
 * diverged and was the only one stripping CSI private-mode sequences
 * (cursor hide/show). Unioning keeps every call site's previous coverage.
 */
const ANSI_RE =
  /\x1b\[[0-9;]*[mGKHF]|\x1b\[\?[0-9]+[hl]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]/g;

/** Remove terminal escape sequences before parsing CLI output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

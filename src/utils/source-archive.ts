import { createGzip } from "node:zlib";

/**
 * The upload source archive (IF-UPLOAD) and the one secret-path rule
 * (IF-SECRET-PATHS), with no filesystem access, so the remote toolset can
 * pack host-supplied files with the same code later.
 *
 * The archive is what deploy-api's validator accepts
 * (`services/deploy-api/src/deployment_sources.py`): exactly one gzip member
 * holding a POSIX tar of regular files only (PAX `path` records for long or
 * non-ASCII names), relative paths with no `.`/`..`/empty segments, no
 * duplicates, and nothing but zero blocks after the last member. Entries are
 * sorted and carry no owner or time, so the same files give the same bytes.
 */

/** N23 product caps; the server is authoritative and may serve a lower `max_bytes`. */
export const SOURCE_CAPS = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntries: 20_000,
  maxRatio: 100,
} as const;

// IF-SECRET-PATHS: the same rule as deploy-api `is_secret_path` (one test table, U-8).
const SECRET_SEGMENTS = new Set(["secrets", ".ssh", ".aws", ".azure", ".kube"]);
const SECRET_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".dockercfg",
  "credentials",
  "credentials.json",
  "application_default_credentials.json",
  "service-account.json",
  "service_account.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "secret.json",
  "secrets.json",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;
const SERVICE_ACCOUNT = /(?:^|[-_])service[-_]?account\.json$/;

/** True when a relative `/`-separated path conventionally holds a credential. */
export function isSecretPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const segments = lower.split("/");
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true;
  const base = segments[segments.length - 1]!;
  if (base.startsWith(".env")) return !ENV_TEMPLATE.test(base);
  const rooted = `/${lower}`;
  return (
    SECRET_BASENAMES.has(base) ||
    base.startsWith("id_rsa") ||
    SECRET_EXTENSIONS.some((extension) => base.endsWith(extension)) ||
    SERVICE_ACCOUNT.test(base) ||
    rooted.includes("/.config/gcloud/") ||
    rooted.endsWith("/.docker/config.json") ||
    rooted.endsWith("/.config/gh/hosts.yml")
  );
}

/** A path the server refuses as unsafe whatever it holds (backslash or control character). */
export function isUnsafeName(relativePath: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\\\u0000-\u001f\u007f]/.test(relativePath);
}

export interface ArchiveFile {
  /** Relative, `/`-separated, already normalized. */
  path: string;
  data: Buffer;
  executable: boolean;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, type: string, prefix = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return block;
}

/** ustar `name`/`prefix` for an ASCII path that fits, else null (needs a PAX record). */
function ustarName(path: string): { name: string; prefix: string } | null {
  if (!/^[\x20-\x7e]*$/.test(path)) return null;
  if (path.length <= 100) return { name: path, prefix: "" };
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  return null;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return Buffer.from(`${length}${body}`, "utf8");
}

function* tarChunks(files: readonly ArchiveFile[]): Generator<Buffer> {
  for (const file of files) {
    const mode = file.executable ? 0o755 : 0o644;
    const fits = ustarName(file.path);
    if (fits) {
      yield header(fits.name, file.data.length, mode, "0", fits.prefix);
    } else {
      const record = paxRecord("path", file.path);
      yield header("PaxHeader", record.length, 0o644, "x");
      yield record;
      yield padding(record.length);
      yield header(file.path.replace(/[^\x20-\x7e]/g, "_").slice(-100), file.data.length, mode, "0");
    }
    yield file.data;
    yield padding(file.data.length);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** One gzip member holding the tar of `files`, sorted by path. */
export async function buildSourceArchive(files: readonly ArchiveFile[]): Promise<Buffer> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const gzip = createGzip({ level: 9 });
  const out: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  for (const chunk of tarChunks(sorted)) {
    if (!gzip.write(chunk)) await new Promise((resolve) => gzip.once("drain", resolve));
  }
  gzip.end();
  await done;
  return Buffer.concat(out);
}

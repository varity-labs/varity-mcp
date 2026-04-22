import { z } from "zod";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

const RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "finally", "for", "function",
  "if", "import", "in", "instanceof", "let", "new", "return", "super",
  "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield",
  "id", "createdAt", "updatedAt",
]);

/**
 * Convert a collection name to PascalCase singular.
 * e.g. "invoices" → "Invoice", "team_members" → "TeamMember"
 */
function toPascalSingular(name: string): string {
  // Remove trailing 's' for a naive singular
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  return singular
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Convert a collection name to PascalCase plural.
 * e.g. "invoices" → "Invoices", "team_members" → "TeamMembers"
 */
function toPascalPlural(name: string): string {
  return name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Convert a collection name to a camelCase accessor.
 * e.g. "invoices" → "invoices", "team_members" → "teamMembers"
 */
function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return parts
    .map((part, i) =>
      i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join("");
}

/**
 * Map a user-friendly type string to a TypeScript type.
 */
function toTSType(type: string): string {
  const map: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    date: "string", // stored as ISO string
    Date: "string",
  };
  return map[type] ?? type;
}

/**
 * Module-level per-project serialization lock.
 *
 * Prevents two concurrent varity_add_collection calls from interleaving file
 * writes, which would produce duplicate TypeScript interfaces and cause
 * compilation errors (BUG-003).
 */
const projectMutexes = new Map<string, Promise<void>>();

async function withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectMutexes.get(projectPath) ?? Promise.resolve();
  let unlock!: () => void;
  const slot = new Promise<void>((res) => { unlock = res; });
  // Future callers wait for this slot; even if fn() throws we release the lock
  projectMutexes.set(projectPath, prev.then(() => slot).catch(() => slot));
  await prev;
  try {
    return await fn();
  } finally {
    unlock();
  }
}

/** Common business acronyms to uppercase in display labels. */
const LABEL_ACRONYMS = new Set([
  'crm', 'api', 'saas', 'ui', 'ux', 'db', 'id', 'hr',
  'b2b', 'b2c', 'ai', 'ml', 'sdk', 'url', 'seo', 'kpi', 'cms', 'erp',
]);

/**
 * Convert a collection name to a human-readable sidebar/display label.
 * e.g. "crm_tasks" → "CRM Tasks", "team_members" → "Team Members"
 * Recognizes common business acronyms and uppercases them fully.
 */
function toHumanLabel(name: string): string {
  return name
    .split(/[_-]/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (LABEL_ACRONYMS.has(lower)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Convert a collection name to a URL-safe slug using hyphens.
 * e.g. "crm_tasks" → "crm-tasks", "team_members" → "team-members"
 */
function toUrlSlug(name: string): string {
  return name.replace(/_/g, "-");
}

/**
 * Convert a raw field name (camelCase or snake_case) to a readable label.
 * e.g. "clientId" → "Client", "firstName" → "First Name", "due_date" → "Due Date"
 *
 * Rules:
 * - camelCase and snake_case are split into words
 * - Standalone "id" / "Id" word is uppercased to "ID"
 * - Trailing "ID" is stripped from foreign-key reference fields
 *   (e.g. "clientId" → "Client", "userId" → "User")
 */
function humanizeFieldName(name: string): string {
  // Replace snake_case underscores with spaces
  const withSpaces = name.replace(/_/g, " ");
  // Split camelCase: insert space before uppercase letters preceded by lowercase
  const camelSplit = withSpaces.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Capitalize each word; normalize "id" / "Id" → "ID"
  const words = camelSplit
    .split(" ")
    .map((word) =>
      word.toLowerCase() === "id" ? "ID" : word.charAt(0).toUpperCase() + word.slice(1)
    );
  // Strip trailing "ID" from reference fields (clientId → "Client", not "Client ID")
  if (words.length > 1 && words[words.length - 1] === "ID") {
    words.pop();
  }
  return words.join(" ");
}

/** Returns true if the error is a disk-full I/O error. */
function isDiskFullError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOSPC" || err.message.includes("ENOSPC") || err.message.includes("no space left");
}

/**
 * Pick a semantic Material icon name based on common collection names.
 * Falls back to 'list' for unknown names.
 */
function getIconForCollection(name: string): string {
  const iconMap: Record<string, string> = {
    // "people" reserved for team/user-type collections so it doesn't clash with
    // business-entity collections like clients/contacts (which get 'tag').
    users: 'people', members: 'people', staff: 'people', team: 'people', employees: 'people',
    clients: 'tag', customers: 'tag', contacts: 'tag', partners: 'tag', vendors: 'tag',
    deals: 'trending_up', opportunities: 'trending_up', leads: 'trending_up', sales: 'trending_up', pipeline: 'trending_up',
    invoices: 'receipt', payments: 'receipt', bills: 'receipt', transactions: 'receipt', charges: 'receipt',
    products: 'inventory', items: 'inventory', inventory: 'inventory', catalog: 'inventory', listings: 'inventory',
    orders: 'shopping_cart', purchases: 'shopping_cart', subscriptions: 'shopping_cart',
    events: 'event', appointments: 'event', meetings: 'event', bookings: 'event', reservations: 'event',
    reports: 'bar_chart', analytics: 'bar_chart', metrics: 'bar_chart', stats: 'bar_chart',
    documents: 'description', files: 'description', notes: 'description', articles: 'description',
    tickets: 'confirmation_number', support: 'confirmation_number', issues: 'confirmation_number', bugs: 'confirmation_number',
    campaigns: 'campaign', announcements: 'campaign', notifications: 'notifications',
  };
  return iconMap[name.toLowerCase()] ?? 'list';
}

async function isTypeScriptProject(projectPath: string): Promise<boolean> {
  try {
    await access(resolve(projectPath, "tsconfig.json"));
    return true;
  } catch {
    return false;
  }
}

export function registerAddCollectionTool(server: McpServer): void {
  server.registerTool(
    "varity_add_collection",
    {
      title: "Add Database Collection",
      description:
        "Add a new database collection to the project. " +
        "Creates the TypeScript type, collection accessor, and React hook. " +
        "Optionally scaffolds a dashboard page.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Project directory (default: current working directory)"),
        name: z
          .string()
          .min(1, "Collection name cannot be empty")
          .regex(
            /^[a-z][a-z0-9_]*$/,
            "Collection name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (e.g. 'invoices', 'team_members')"
          )
          .describe(
            "Collection name (lowercase, e.g. 'invoices', 'team_members')"
          ),
        fields: z
          .array(
            z.object({
              name: z
                .string()
                .min(1, "Field name cannot be empty")
                .describe("Field name (e.g. 'amount')"),
              type: z
                .enum(["string", "number", "boolean", "Date"])
                .describe(
                  "Field type: 'string', 'number', 'boolean', or 'Date'"
                ),
            })
          )
          .describe("Array of field definitions for the collection"),
        add_page: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Scaffold a dashboard page with DataTable and Dialog (default: false)"
          ),
      },
    },
    async ({ path, name, fields, add_page }) => {
      const projectPath = resolve(path || process.cwd());

      const pascalSingular = toPascalSingular(name);
      const pascalPlural = toPascalPlural(name);
      const camelPlural = toCamelCase(name);
      const hookName = `use${pascalPlural}`;
      const humanLabel = toHumanLabel(name);   // e.g. "crm_tasks" → "CRM Tasks"
      const urlSlug = toUrlSlug(name);          // e.g. "crm_tasks" → "crm-tasks"
      // Singular human label for user-facing copy (button text, dialog titles, toasts)
      // e.g. "crm_clients" → strip trailing 's' → "crm_client" → "CRM Client"
      const singularName = name.endsWith("s") ? name.slice(0, -1) : name;
      const humanLabelSingular = toHumanLabel(singularName); // e.g. "CRM Client"

      // Validate field names against reserved words
      const invalidField = fields.find((f: { name: string }) => RESERVED_WORDS.has(f.name));
      if (invalidField) {
        return errorResponse(
          "INVALID_FIELD_NAME",
          `Field name "${invalidField.name}" is a reserved word and cannot be used.`,
          "Choose a different field name. Reserved: id, createdAt, updatedAt, and JavaScript keywords like class, delete, return, etc."
        );
      }

      // Serialize all file operations per project path.
      // This prevents two simultaneous calls from interleaving writes and
      // producing duplicate interfaces in types/index.ts (BUG-003).
      return withProjectLock(projectPath, async () => {
        const filesModified: string[] = [];
        const filesCreated: string[] = [];

        const isTS = await isTypeScriptProject(projectPath);
        const ext = isTS ? "ts" : "js";

        // ── Read all source files up front before writing anything ──
        // This allows us to do collision checks and rollback atomically (BUG-002).

        const typesPath = resolve(projectPath, "src/types/index.ts");
        const dbPath = resolve(projectPath, `src/lib/database.${ext}`);
        const hooksPath = resolve(projectPath, `src/lib/hooks.${ext}`);

        // Read files — create boilerplate if missing (supports custom apps, not just varity_init projects)
        let typesOriginal: string = "";
        let typesWasCreated = false;
        if (isTS) {
          try {
            typesOriginal = await readFile(typesPath, "utf-8");
          } catch {
            // File doesn't exist — create it with minimal boilerplate
            typesOriginal = `// Varity data types — auto-generated\n`;
            typesWasCreated = true;
            try {
              await mkdir(dirname(typesPath), { recursive: true });
              await writeFile(typesPath, typesOriginal, "utf-8");
            } catch (err) {
              if (isDiskFullError(err)) {
                return errorResponse("DISK_FULL", "Could not create src/types/index.ts — disk is full.", "Free up disk space and try again.");
              }
              return errorResponse("FILE_CREATE_FAILED", `Could not create ${typesPath}`, "Check directory permissions.");
            }
          }
        }

        let dbOriginal: string;
        let dbWasCreated = false;
        try {
          dbOriginal = await readFile(dbPath, "utf-8");
        } catch {
          // File doesn't exist — create it with boilerplate
          dbOriginal = isTS
            ? `import { db } from '@varity-labs/sdk';\nimport type {  } from '../types';\n\nexport { db };\n`
            : `import { db } from '@varity-labs/sdk';\n\nexport { db };\n`;
          dbWasCreated = true;
          try {
            await mkdir(dirname(dbPath), { recursive: true });
            await writeFile(dbPath, dbOriginal, "utf-8");
          } catch (err) {
            if (isDiskFullError(err)) {
              return errorResponse("DISK_FULL", "Could not create src/lib/database.ts — disk is full.", "Free up disk space and try again.");
            }
            return errorResponse("FILE_CREATE_FAILED", `Could not create ${dbPath}`, "Check directory permissions.");
          }
        }

        let hooksOriginal: string;
        let hooksWasCreated = false;
        try {
          hooksOriginal = await readFile(hooksPath, "utf-8");
        } catch {
          // File doesn't exist — create it with boilerplate including UseCollectionReturn type (TS only)
          hooksOriginal = isTS
            ? `import { useState, useEffect, useCallback } from 'react';\nimport type {  } from '../types';\nimport {  } from './database';\n\nexport interface UseCollectionReturn<T> {\n  data: T[];\n  loading: boolean;\n  error: string | null;\n  create: (input: Omit<T, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;\n  update: (id: string, updates: Partial<T>) => Promise<void>;\n  remove: (id: string) => Promise<void>;\n  refresh: () => Promise<void>;\n}\n`
            : `import { useState, useEffect, useCallback } from 'react';\nimport {  } from './database';\n`;
          hooksWasCreated = true;
          try {
            await mkdir(dirname(hooksPath), { recursive: true });
            await writeFile(hooksPath, hooksOriginal, "utf-8");
          } catch (err) {
            if (isDiskFullError(err)) {
              return errorResponse("DISK_FULL", "Could not create src/lib/hooks.ts — disk is full.", "Free up disk space and try again.");
            }
            return errorResponse("FILE_CREATE_FAILED", `Could not create ${hooksPath}`, "Check directory permissions.");
          }
        }

        // ── Check for existing or partially-added collection ──

        const alreadyInTypes = isTS && typesOriginal.includes(`export interface ${pascalSingular}`);
        const alreadyInDb = dbOriginal.includes(`export const ${camelPlural} =`);

        if (alreadyInDb && alreadyInTypes) {
          // Produce a diff of existing fields vs. requested fields so the developer
          // knows what they already have and what options they have.
          const existingFieldsMatch = typesOriginal.match(
            new RegExp(`export interface ${pascalSingular}[^{]*\\{([^}]*)\\}`, "s")
          );
          const existingFieldsSummary = existingFieldsMatch
            ? existingFieldsMatch[1]!
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith("//"))
                .join(", ")
            : "unknown fields";
          const requestedFieldsSummary = fields
            .map((f: { name: string; type: string }) => `${f.name}: ${f.type}`)
            .join(", ");
          const suggestedName = `${name.replace(/s$/, "")}_records`;
          return errorResponse(
            "COLLECTION_EXISTS",
            `Collection '${name}' already exists in this project with different fields.\n` +
              `  Existing fields: ${existingFieldsSummary}\n` +
              `  You requested:   ${requestedFieldsSummary}`,
            `Options:\n` +
              `  1. Use the existing collection — import the hook: import { ${hookName} } from '@/lib/hooks'\n` +
              `  2. Use a different name — e.g. run: varity_add_collection({ name: "${suggestedName}", fields: [...] })\n` +
              `  3. Extend the existing type — manually add your fields to src/types/index.ts and src/lib/database.ts`
          );
        }

        if (alreadyInDb || alreadyInTypes) {
          // Partial state — a previous run was interrupted. Report exactly what exists.
          return errorResponse(
            "COLLECTION_PARTIAL_STATE",
            `Collection '${name}' is in a partial state: ${
              alreadyInTypes
                ? `'${pascalSingular}' interface found in src/types/index.ts`
                : "type interface missing from src/types/index.ts"
            } but ${
              alreadyInDb
                ? `'${camelPlural}()' accessor found in src/lib/database.ts`
                : "accessor missing from src/lib/database.ts"
            }.`,
            `To recover: remove any incomplete '${name}' entries from src/types/index.ts and src/lib/database.ts, then run varity_add_collection again.`
          );
        }

        // ── Build all new file contents in memory before writing ──

        // 1. New types/index.ts — append interface (TypeScript projects only)
        let newTypesContent = typesOriginal;
        if (isTS) {
          const fieldLines = fields
            .map((f) => `  ${f.name}: ${toTSType(f.type)};`)
            .join("\n");
          const interfaceBlock = [
            "",
            `export interface ${pascalSingular} {`,
            "  id: string;",
            fieldLines,
            "  createdAt: string;",
            "  updatedAt: string;",
            "}",
            "",
          ].join("\n");
          newTypesContent = typesOriginal.trimEnd() + "\n" + interfaceBlock;
        }

        // 2. New database file — add type import (TS only) + accessor
        let dbContent = dbOriginal;
        if (isTS) {
          const importRegex = /import\s+type\s*\{([^}]+)\}\s*from\s*['"]\.\.\/types['"]/;
          const importMatch = dbContent.match(importRegex);
          if (importMatch) {
            const existingTypes = importMatch[1]!;
            if (!existingTypes.includes(pascalSingular)) {
              const trimmed = existingTypes.trim();
              const updatedTypes = trimmed ? `${trimmed}, ${pascalSingular}` : ` ${pascalSingular}`;
              dbContent = dbContent.replace(importRegex, `import type {${updatedTypes}} from '../types'`);
            }
          } else {
            // No existing type import — add one after the last import line or at top
            const lastImportIdx = dbContent.lastIndexOf("import ");
            if (lastImportIdx !== -1) {
              const lineEnd = dbContent.indexOf("\n", lastImportIdx);
              dbContent =
                dbContent.slice(0, lineEnd + 1) +
                `import type { ${pascalSingular} } from '../types';\n` +
                dbContent.slice(lineEnd + 1);
            } else {
              dbContent = `import type { ${pascalSingular} } from '../types';\n` + dbContent;
            }
          }
        }
        const accessorLine = isTS
          ? `export const ${camelPlural} = () => db.collection<${pascalSingular}>('${name}');`
          : `export const ${camelPlural} = () => db.collection('${name}');`;
        const newDbContent = dbContent.trimEnd() + "\n" + accessorLine + "\n";

        // 3. New hooks file — add accessor import + type import (TS only) + hook function
        let hooksContent = hooksOriginal;
        const dbImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/database['"]/;
        const dbImportMatch = hooksContent.match(dbImportRegex);
        if (dbImportMatch) {
          const existingImports = dbImportMatch[1]!;
          if (!existingImports.includes(camelPlural)) {
            const trimmedImports = existingImports.trim();
            const updatedImports = trimmedImports ? `${trimmedImports}, ${camelPlural}` : ` ${camelPlural}`;
            hooksContent = hooksContent.replace(
              dbImportRegex,
              `import {${updatedImports}} from './database'`
            );
          }
        } else {
          // No existing database import — add one at the top
          hooksContent = `import { ${camelPlural} } from './database';\n` + hooksContent;
        }

        if (isTS) {
          const typeImportRegex = /import\s+type\s*\{([^}]+)\}\s*from\s*['"]\.\.\/types['"]/;
          const typeImportMatch = hooksContent.match(typeImportRegex);
          if (typeImportMatch) {
            const existingTypes = typeImportMatch[1]!;
            if (!existingTypes.includes(pascalSingular)) {
              const trimmed = existingTypes.trim();
              const updatedTypes = trimmed ? `${trimmed}, ${pascalSingular}` : ` ${pascalSingular}`;
              hooksContent = hooksContent.replace(
                typeImportRegex,
                `import type {${updatedTypes}} from '../types'`
              );
            }
          } else {
            // No existing types import — add one at the top (after any existing imports)
            const lastImportIdxHooks = hooksContent.lastIndexOf("import ");
            if (lastImportIdxHooks !== -1) {
              const lineEndHooks = hooksContent.indexOf("\n", lastImportIdxHooks);
              hooksContent =
                hooksContent.slice(0, lineEndHooks + 1) +
                `import type { ${pascalSingular} } from '../types';\n` +
                hooksContent.slice(lineEndHooks + 1);
            } else {
              hooksContent = `import type { ${pascalSingular} } from '../types';\n` + hooksContent;
            }
          }
        }

        const hookBlock = isTS ? `
export function ${hookName}(): UseCollectionReturn<${pascalSingular}> {
  const [data, setData] = useState<${pascalSingular}[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await ${camelPlural}().get();
      setData(result as ${pascalSingular}[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (input: Omit<${pascalSingular}, 'id' | 'createdAt' | 'updatedAt'>) => {
    const optimistic: ${pascalSingular} = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as ${pascalSingular};
    setData(prev => [optimistic, ...prev]);
    try {
      await ${camelPlural}().add({ ...input, createdAt: optimistic.createdAt });
      await refresh();
    } catch (err) {
      setData(prev => prev.filter(p => p.id !== optimistic.id));
      throw err;
    }
  };

  const update = async (id: string, updates: Partial<${pascalSingular}>) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    try {
      await ${camelPlural}().update(id, updates);
    } catch (err) {
      if (original) setData(prev => prev.map(p => p.id === id ? original : p));
      throw err;
    }
  };

  const remove = async (id: string) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.filter(p => p.id !== id));
    try {
      await ${camelPlural}().delete(id);
    } catch (err) {
      if (original) setData(prev => [...prev, original]);
      throw err;
    }
  };

  return { data, loading, error, create, update, remove, refresh };
}
` : `
export function ${hookName}() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await ${camelPlural}().get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (input) => {
    const optimistic = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setData(prev => [optimistic, ...prev]);
    try {
      await ${camelPlural}().add({ ...input, createdAt: optimistic.createdAt });
      await refresh();
    } catch (err) {
      setData(prev => prev.filter(p => p.id !== optimistic.id));
      throw err;
    }
  };

  const update = async (id, updates) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    try {
      await ${camelPlural}().update(id, updates);
    } catch (err) {
      if (original) setData(prev => prev.map(p => p.id === id ? original : p));
      throw err;
    }
  };

  const remove = async (id) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.filter(p => p.id !== id));
    try {
      await ${camelPlural}().delete(id);
    } catch (err) {
      if (original) setData(prev => [...prev, original]);
      throw err;
    }
  };

  return { data, loading, error, create, update, remove, refresh };
}
`;
        const newHooksContent = hooksContent.trimEnd() + "\n" + hookBlock;

        // ── Write all three files. Rollback all on any failure (BUG-002). ──

        /** Restore files to their pre-call content. Best-effort. */
        async function rollbackAll(): Promise<void> {
          const tasks: Promise<void>[] = [
            writeFile(dbPath, dbOriginal, "utf-8"),
            writeFile(hooksPath, hooksOriginal, "utf-8"),
          ];
          if (isTS) tasks.push(writeFile(typesPath, typesOriginal, "utf-8"));
          await Promise.allSettled(tasks);
        }

        if (isTS) {
          try {
            await writeFile(typesPath, newTypesContent, "utf-8");
          } catch (err) {
            if (isDiskFullError(err)) {
              return errorResponse(
                "DISK_FULL",
                "Could not write src/types/index.ts — disk is full. No files were modified.",
                "Free up disk space and try again. Run `df -h` to see available space."
              );
            }
            throw err;
          }
          filesModified.push("src/types/index.ts");
        }

        try {
          await writeFile(dbPath, newDbContent, "utf-8");
        } catch (err) {
          await rollbackAll();
          if (isDiskFullError(err)) {
            return errorResponse(
              "DISK_FULL",
              `Could not write src/lib/database.${ext} — disk is full. All changes have been rolled back.`,
              "Free up disk space and try again. Run `df -h` to see available space."
            );
          }
          throw err;
        }
        filesModified.push(`src/lib/database.${ext}`);

        try {
          await writeFile(hooksPath, newHooksContent, "utf-8");
        } catch (err) {
          await rollbackAll();
          if (isDiskFullError(err)) {
            return errorResponse(
              "DISK_FULL",
              `Could not write src/lib/hooks.${ext} — disk is full. All changes have been rolled back.`,
              "Free up disk space and try again. Run `df -h` to see available space."
            );
          }
          throw err;
        }
        filesModified.push(`src/lib/hooks.${ext}`);

        // ── 4. Optionally scaffold a dashboard page ──

        if (add_page) {
          const pagePath = resolve(
            projectPath,
            `src/app/dashboard/${urlSlug}/page.${isTS ? "tsx" : "jsx"}`
          );
          const pageDir = dirname(pagePath);

          // Detect foreign-key reference fields (*Id naming convention).
          // These render as a <Select> populated by the related collection's
          // hook so the developer picks from real items rather than typing raw IDs.
          // Computed before columnDefs so FK columns can use a render function.
          const refFields = fields
            .map((f) => {
              if (!f.name.endsWith("Id") || f.name.length <= 2) return null;
              const base = f.name.slice(0, -2); // "client" from "clientId"
              const basePlural = base + "s";     // naive plural: "clients"
              const pascalPluralRel =
                basePlural.charAt(0).toUpperCase() + basePlural.slice(1);
              return {
                fieldName: f.name,
                dataVar: basePlural,                       // "clients"
                relatedHookName: `use${pascalPluralRel}`,  // "useClients"
                label: humanizeFieldName(f.name),
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);

          // Deduplicate (two fields could reference the same collection)
          const uniqueRefHooks = [
            ...new Map(refFields.map((r) => [r.relatedHookName, r])).values(),
          ];

          // Build column definitions from fields.
          // FK fields (*Id) get a render fn that resolves the stored UUID to a
          // display name using the related collection's already-loaded data,
          // so the table shows "Acme Corp" instead of a raw UUID (DX-004).
          const columnDefs = fields
            .map((f) => {
              const ref = refFields.find((r) => r.fieldName === f.name);
              if (ref) {
                const mapVar = `${ref.dataVar.replace(/s$/, "")}Map`;
                const renderArg = isTS ? "(v: string)" : "(v)";
                return `    { key: '${f.name}', header: '${humanizeFieldName(f.name)}', sortable: true, render: ${renderArg} => ${mapVar}[v] ?? v },`;
              }
              return `    { key: '${f.name}', header: '${humanizeFieldName(f.name)}', sortable: true },`;
            })
            .join("\n");

          // Build form field state defaults
          const formDefaults = fields
            .map((f) => {
              const tsType = toTSType(f.type);
              if (tsType === "number") return `${f.name}: 0`;
              if (tsType === "boolean") return `${f.name}: false`;
              return `${f.name}: ''`;
            })
            .join(", ");

          // Build form inputs
          const formInputs = fields
            .map((f) => {
              const tsType = toTSType(f.type);
              const label = humanizeFieldName(f.name);

              // Reference field → <Select> populated by the related collection hook
              const ref = refFields.find((r) => r.fieldName === f.name);
              if (ref) {
                const mapItemArg = isTS ? "(item: { id: string; name?: string; email?: string })" : "(item)";
                return `          <Select label="${label}" value={form.${f.name}} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: e.target.value }))} options={[{ value: '', label: 'Select ${ref.label}...' }, ...${ref.dataVar}.map(${mapItemArg} => ({ value: item.id, label: item.name ?? item.email ?? item.id }))]} />`;
              }
              if (tsType === "number") {
                return `          <Input label="${label}" type="number" value={String(form.${f.name})} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: Number(e.target.value) }))} />`;
              }
              if (tsType === "boolean") {
                return `          <label className="flex items-center gap-2"><input type="checkbox" checked={form.${f.name}} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: e.target.checked }))} /> ${label}</label>`;
              }
              return `          <Input label="${label}" value={form.${f.name}} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: e.target.value }))} />`;
            })
            .join("\n");

          // Build dynamic import strings for reference-field hooks
          const needsSelect = refFields.length > 0;
          const refHookImportStr = uniqueRefHooks.length > 0
            ? `, ${uniqueRefHooks.map((r) => r.relatedHookName).join(", ")}`
            : "";
          const refHookUsageLines = uniqueRefHooks.length > 0
            ? "\n" + uniqueRefHooks
                .map((r) => `  const { data: ${r.dataVar} } = ${r.relatedHookName}();`)
                .join("\n")
            : "";

          // Build lookup maps for FK fields so DataTable columns can resolve
          // stored UUIDs to human-readable display names (DX-004 fix).
          // e.g. clientId "a1b2…" → "Acme Corp" using the already-loaded clients array.
          const refMapLines = uniqueRefHooks.length > 0
            ? "\n" + uniqueRefHooks
                .map((r) => {
                  const mapVar = `${r.dataVar.replace(/s$/, "")}Map`;
                  const mapDecl = isTS ? `const ${mapVar}: Record<string, string>` : `const ${mapVar}`;
                  const mapItemArg = isTS ? "(item: { id: string; name?: string; email?: string })" : "(item)";
                  return [
                    `  ${mapDecl} = Object.fromEntries(`,
                    `    ${r.dataVar}.map(${mapItemArg} => [item.id, item.name ?? item.email ?? item.id])`,
                    `  );`,
                  ].join("\n");
                })
                .join("\n")
            : "";

          // Build validation guard lines for required fields in handleCreate.
          // String fields must be non-empty; reference (select) fields must have a selection.
          const validationLines = fields
            .map((f) => {
              const tsType = toTSType(f.type);
              if (tsType !== "string") return null;
              const ref = refFields.find((r) => r.fieldName === f.name);
              const label = humanizeFieldName(f.name);
              if (ref) {
                return `    if (!form.${f.name}) { toast.error('Select a ${label}'); return; }`;
              }
              return `    if (!form.${f.name}.trim()) { toast.error('${label} is required'); return; }`;
            })
            .filter(Boolean)
            .join("\n");

          const typeImport = isTS ? `\nimport type { ${pascalSingular} } from '@/types';` : "";
          const createArg = isTS ? `form as Omit<${pascalSingular}, 'id' | 'createdAt' | 'updatedAt'>` : "form";
          const handleDeleteSig = isTS ? "async function handleDelete(id: string)" : "async function handleDelete(id)";
          const actionsRender = isTS ? `(_: unknown, row: ${pascalSingular})` : "(_, row)";

          const pageContent = `'use client';

import { useState } from 'react';
import { DataTable, EmptyState } from '@varity-labs/ui-kit';
import { Button, Input, ${needsSelect ? "Select, " : ""}Dialog, useToast } from '@varity-labs/ui-kit';
import { ${hookName}${refHookImportStr} } from '@/lib/hooks';${typeImport}
import { Plus } from 'lucide-react';

const EMPTY_FORM = { ${formDefaults} };

export default function ${pascalPlural}Page() {
  const toast = useToast();
  const { data: items, loading, error, create, remove, refresh } = ${hookName}();${refHookUsageLines}${refMapLines}

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
${validationLines ? validationLines + "\n" : ""}    setSubmitting(true);
    try {
      await create(${createArg});
      toast.success('${humanLabelSingular} created');
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      toast.error('Failed to create ${humanLabelSingular.toLowerCase()}');
    } finally {
      setSubmitting(false);
    }
  }

  ${handleDeleteSig} {
    try {
      await remove(id);
      toast.success('${humanLabelSingular} deleted');
    } catch {
      toast.error('Failed to delete');
    }
  }

  const columns = [
${columnDefs}
    {
      key: 'actions',
      header: '',
      render: ${actionsRender} => (
        <button onClick={() => handleDelete(row.id)} className="text-red-600 hover:text-red-800 text-sm">
          Delete
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">${humanLabel}</h1>
          <p className="mt-1 text-sm text-gray-600">Manage your ${humanLabel.toLowerCase()}.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} icon={<Plus className="h-4 w-4" />}>
          New ${humanLabelSingular}
        </Button>
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create ${humanLabelSingular}">
        <div className="space-y-4">
${formInputs}
          <Button onClick={handleCreate} loading={submitting}>Create</Button>
        </div>
      </Dialog>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-700">Failed to load ${humanLabel.toLowerCase()}.</p>
          <button onClick={refresh} className="text-sm text-red-700 underline">Retry</button>
        </div>
      )}

      {!loading && items.length === 0 ? (
        <EmptyState
          title="No ${humanLabel.toLowerCase()} yet"
          description="Create your first ${humanLabelSingular.toLowerCase()}."
          action={{ label: 'Create ${humanLabelSingular}', onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <DataTable columns={columns} data={items} loading={loading} pagination pageSize={10} hoverable />
        </div>
      )}
    </div>
  );
}
`;

          try {
            await mkdir(pageDir, { recursive: true });
          } catch (err) {
            await rollbackAll();
            if (isDiskFullError(err)) {
              return errorResponse(
                "DISK_FULL",
                `Could not create page directory — disk is full. All changes have been rolled back.`,
                "Free up disk space and try again. Run `df -h` to see available space."
              );
            }
            return errorResponse(
              "PAGE_CREATE_FAILED",
              `Could not create directory: ${pageDir}`,
              "Check directory permissions and try again. All collection files (type, accessor, hook) have been rolled back."
            );
          }

          try {
            await writeFile(pagePath, pageContent, "utf-8");
          } catch (err) {
            await rollbackAll();
            if (isDiskFullError(err)) {
              return errorResponse(
                "DISK_FULL",
                `Could not write page file — disk is full. All changes have been rolled back.`,
                "Free up disk space and try again. Run `df -h` to see available space."
              );
            }
            return errorResponse(
              "PAGE_CREATE_FAILED",
              `Could not write dashboard page: ${pagePath}`,
              "Check file permissions and try again. All collection files (type, accessor, hook) have been rolled back."
            );
          }
          filesCreated.push(`src/app/dashboard/${urlSlug}/page.${isTS ? "tsx" : "jsx"}`);

          // BUG #7: Ensure ToastProvider wraps the dashboard so useToast() works.
          // Check if dashboard layout exists and has ToastProvider. If not, create it.
          const layoutExt = isTS ? "tsx" : "jsx";
          const dashboardLayoutPath = resolve(projectPath, `src/app/dashboard/layout.${layoutExt}`);
          const mainLayoutPath = resolve(projectPath, `src/app/layout.${layoutExt}`);
          let toastProviderPresent = false;
          try {
            const mainLayoutContent = await readFile(mainLayoutPath, "utf-8");
            if (mainLayoutContent.includes("ToastProvider")) toastProviderPresent = true;
          } catch { /* main layout may not exist */ }
          if (!toastProviderPresent) {
            try {
              const dashLayoutContent = await readFile(dashboardLayoutPath, "utf-8");
              if (dashLayoutContent.includes("ToastProvider")) toastProviderPresent = true;
            } catch { /* dashboard layout may not exist */ }
          }
          if (!toastProviderPresent) {
            // Create a minimal dashboard layout that provides ToastProvider
            const dashboardLayoutContent = isTS
              ? `'use client';\nimport { ToastProvider } from '@varity-labs/ui-kit';\nimport type { ReactNode } from 'react';\n\nexport default function DashboardLayout({ children }: { children: ReactNode }) {\n  return <ToastProvider>{children}</ToastProvider>;\n}\n`
              : `'use client';\nimport { ToastProvider } from '@varity-labs/ui-kit';\n\nexport default function DashboardLayout({ children }) {\n  return <ToastProvider>{children}</ToastProvider>;\n}\n`;
            try {
              await mkdir(dirname(dashboardLayoutPath), { recursive: true });
              await writeFile(dashboardLayoutPath, dashboardLayoutContent, "utf-8");
              filesCreated.push(`src/app/dashboard/layout.${layoutExt}`);
            } catch { /* non-critical — page still works, just no toast notifications */ }
          }

          // Ensure tsconfig.json has @/ path alias so generated page imports work.
          // Custom apps (not created via varity_init) won't have this configured.
          if (isTS) {
            const tsconfigPath = resolve(projectPath, "tsconfig.json");
            try {
              const tsconfigContent = await readFile(tsconfigPath, "utf-8");
              const tsconfig = JSON.parse(tsconfigContent);
              const paths = tsconfig.compilerOptions?.paths ?? {};
              if (!paths["@/*"]) {
                if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
                if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
                tsconfig.compilerOptions.paths["@/*"] = ["./src/*"];
                await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n", "utf-8");
                filesModified.push("tsconfig.json");
              }
            } catch {
              // tsconfig.json may not be valid JSON — skip silently
            }
          }

          // Auto-add navigation item to sidebar so the page is reachable
          const constantsPath = resolve(projectPath, `src/lib/constants.${ext}`);
          try {
            const constantsContent = await readFile(constantsPath, "utf-8");
            if (!constantsContent.includes(`/dashboard/${urlSlug}`)) {
              // Insert before the Settings nav item (last functional item)
              const settingsLine = `  { label: 'Settings'`;
              const navIcon = getIconForCollection(name);
              const newNavItem = `  { label: '${humanLabel}', icon: '${navIcon}', path: '/dashboard/${urlSlug}' },\n`;
              const updatedConstants = constantsContent.includes(settingsLine)
                ? constantsContent.replace(settingsLine, newNavItem + settingsLine)
                : constantsContent.replace(
                    // Fallback: insert before the closing ]; of NAVIGATION_ITEMS
                    // followed by the next export const (e.g. PRIORITY_OPTIONS)
                    /(\];)\s*\nexport const/,
                    `${newNavItem}$1\n\nexport const`
                  );
              if (updatedConstants !== constantsContent) {
                await writeFile(constantsPath, updatedConstants, "utf-8");
                filesModified.push(`src/lib/constants.${ext}`);
              }
            }
          } catch {
            // constants.ts may not exist in all templates — skip silently
          }
        }

        // Update varity.config.json collections array
        try {
          const configPath = resolve(projectPath, "varity.config.json");
          const configContent = await readFile(configPath, "utf-8");
          const config = JSON.parse(configContent);
          if (config.database?.collections && !config.database.collections.includes(name)) {
            config.database.collections.push(name);
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
            filesModified.push("varity.config.json");
          }
        } catch {
          // Config file may not exist — skip silently
        }

        return successResponse(
          {
            collection_name: name,
            type_name: pascalSingular,
            hook_name: hookName,
            accessor_name: camelPlural,
            files_modified: filesModified,
            files_created: filesCreated,
            next_steps: [
              `Import { ${hookName} } from '@/lib/hooks' in your components`,
              `Use the ${camelPlural}() accessor for direct database access`,
              ...(add_page
                ? [
                    `Navigate to /dashboard/${urlSlug} to see the new page`,
                    filesModified.includes(`src/lib/constants.${ext}`)
                      ? `✅ Sidebar navigation updated — "${humanLabel}" menu item added automatically`
                      : `Add a navigation entry to src/lib/constants.${ext}: { label: '${humanLabel}', icon: '${getIconForCollection(name)}', path: '/dashboard/${urlSlug}' }`,
                  ]
                : [
                    `Run with add_page=true to scaffold a dashboard page at /dashboard/${urlSlug}`,
                  ]),
            ],
          },
          `Added "${name}" collection: ${isTS ? `${pascalSingular} type, ` : ""}${camelPlural}() accessor, and ${hookName}() hook.${
            add_page
              ? ` Dashboard page created at src/app/dashboard/${urlSlug}/page.${isTS ? "tsx" : "jsx"}.${filesModified.includes(`src/lib/constants.${ext}`) ? " Sidebar navigation updated." : ""}`
              : ""
          }`
        );
      }); // end withProjectLock
    }
  );
}

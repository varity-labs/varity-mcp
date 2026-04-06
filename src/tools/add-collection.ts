import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";

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
          .describe(
            "Collection name (lowercase, e.g. 'invoices', 'team_members')"
          ),
        fields: z
          .array(
            z.object({
              name: z.string().describe("Field name (e.g. 'amount')"),
              type: z
                .string()
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
      const filesModified: string[] = [];
      const filesCreated: string[] = [];

      const pascalSingular = toPascalSingular(name);
      const pascalPlural = toPascalPlural(name);
      const camelPlural = toCamelCase(name);
      const hookName = `use${pascalPlural}`;

      // ── 1. Append interface to src/types/index.ts ──

      const typesPath = resolve(projectPath, "src/types/index.ts");
      let typesContent: string;
      try {
        typesContent = await readFile(typesPath, "utf-8");
      } catch {
        return errorResponse(
          "FILE_NOT_FOUND",
          `Could not read ${typesPath}`,
          "Ensure the project was created with varity_init and has src/types/index.ts."
        );
      }

      // Build the interface
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

      typesContent = typesContent.trimEnd() + "\n" + interfaceBlock;
      await writeFile(typesPath, typesContent, "utf-8");
      filesModified.push("src/types/index.ts");

      // ── 2. Add collection accessor to src/lib/database.ts ──

      const dbPath = resolve(projectPath, "src/lib/database.ts");
      let dbContent: string;
      try {
        dbContent = await readFile(dbPath, "utf-8");
      } catch {
        return errorResponse(
          "FILE_NOT_FOUND",
          `Could not read ${dbPath}`,
          "Ensure the project has src/lib/database.ts."
        );
      }

      // Add the import for the new type if not already present
      const importRegex = /import\s+type\s*\{([^}]+)\}\s*from\s*['"]\.\.\/types['"]/;
      const importMatch = dbContent.match(importRegex);
      if (importMatch) {
        const existingTypes = importMatch[1]!;
        if (!existingTypes.includes(pascalSingular)) {
          const updatedTypes = existingTypes.trimEnd() + `, ${pascalSingular}`;
          dbContent = dbContent.replace(importRegex, `import type {${updatedTypes}} from '../types'`);
        }
      } else {
        // No existing type import — add one at the top after other imports
        const lastImportIdx = dbContent.lastIndexOf("import ");
        if (lastImportIdx !== -1) {
          const lineEnd = dbContent.indexOf("\n", lastImportIdx);
          dbContent =
            dbContent.slice(0, lineEnd + 1) +
            `import type { ${pascalSingular} } from '../types';\n` +
            dbContent.slice(lineEnd + 1);
        }
      }

      // Append the accessor
      const accessorLine = `export const ${camelPlural} = () => db.collection<${pascalSingular}>('${name}');`;
      dbContent = dbContent.trimEnd() + "\n" + accessorLine + "\n";
      await writeFile(dbPath, dbContent, "utf-8");
      filesModified.push("src/lib/database.ts");

      // ── 3. Add React hook to src/lib/hooks.ts ──

      const hooksPath = resolve(projectPath, "src/lib/hooks.ts");
      let hooksContent: string;
      try {
        hooksContent = await readFile(hooksPath, "utf-8");
      } catch {
        return errorResponse(
          "FILE_NOT_FOUND",
          `Could not read ${hooksPath}`,
          "Ensure the project has src/lib/hooks.ts."
        );
      }

      // Add import for the new accessor in the database import
      const dbImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/database['"]/;
      const dbImportMatch = hooksContent.match(dbImportRegex);
      if (dbImportMatch) {
        const existingImports = dbImportMatch[1]!;
        if (!existingImports.includes(camelPlural)) {
          const updatedImports = existingImports.trimEnd() + `, ${camelPlural}`;
          hooksContent = hooksContent.replace(
            dbImportRegex,
            `import {${updatedImports}} from './database'`
          );
        }
      }

      // Add import for the new type
      const typeImportRegex = /import\s+type\s*\{([^}]+)\}\s*from\s*['"]\.\.\/types['"]/;
      const typeImportMatch = hooksContent.match(typeImportRegex);
      if (typeImportMatch) {
        const existingTypes = typeImportMatch[1]!;
        if (!existingTypes.includes(pascalSingular)) {
          const updatedTypes = existingTypes.trimEnd() + `, ${pascalSingular}`;
          hooksContent = hooksContent.replace(
            typeImportRegex,
            `import type {${updatedTypes}} from '../types'`
          );
        }
      }

      // Append the hook
      const hookBlock = `
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
`;
      hooksContent = hooksContent.trimEnd() + "\n" + hookBlock;
      await writeFile(hooksPath, hooksContent, "utf-8");
      filesModified.push("src/lib/hooks.ts");

      // ── 4. Optionally scaffold a dashboard page ──

      if (add_page) {
        const pagePath = resolve(
          projectPath,
          `src/app/dashboard/${name}/page.tsx`
        );
        const pageDir = dirname(pagePath);
        await mkdir(pageDir, { recursive: true });

        // Build column definitions from fields
        const columnDefs = fields
          .map(
            (f) =>
              `    { key: '${f.name}', header: '${f.name.charAt(0).toUpperCase() + f.name.slice(1)}', sortable: true },`
          )
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
            const label =
              f.name.charAt(0).toUpperCase() + f.name.slice(1);
            if (tsType === "number") {
              return `          <Input label="${label}" type="number" value={String(form.${f.name})} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: Number(e.target.value) }))} />`;
            }
            if (tsType === "boolean") {
              return `          <label className="flex items-center gap-2"><input type="checkbox" checked={form.${f.name}} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: e.target.checked }))} /> ${label}</label>`;
            }
            return `          <Input label="${label}" value={form.${f.name}} onChange={(e) => setForm(prev => ({ ...prev, ${f.name}: e.target.value }))} />`;
          })
          .join("\n");

        const pageContent = `'use client';

import { useState } from 'react';
import { DataTable, EmptyState } from '@varity-labs/ui-kit';
import { Button, Input, Dialog, useToast } from '@varity-labs/ui-kit';
import { ${hookName} } from '@/lib/hooks';
import type { ${pascalSingular} } from '@/types';
import { Plus } from 'lucide-react';

const EMPTY_FORM = { ${formDefaults} };

export default function ${pascalPlural}Page() {
  const toast = useToast();
  const { data: items, loading, error, create, remove, refresh } = ${hookName}();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    setSubmitting(true);
    try {
      await create(form as any);
      toast.success('${pascalSingular} created');
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      toast.error('Failed to create ${pascalSingular.toLowerCase()}');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await remove(id);
      toast.success('${pascalSingular} deleted');
    } catch {
      toast.error('Failed to delete');
    }
  }

  const columns = [
${columnDefs}
    {
      key: 'actions',
      header: '',
      render: (_: unknown, row: ${pascalSingular}) => (
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
          <h1 className="text-2xl font-bold text-gray-900">${pascalPlural}</h1>
          <p className="mt-1 text-sm text-gray-600">Manage your ${name}.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} icon={<Plus className="h-4 w-4" />}>
          New ${pascalSingular}
        </Button>
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create ${pascalSingular}">
        <div className="space-y-4">
${formInputs}
          <Button onClick={handleCreate} loading={submitting}>Create</Button>
        </div>
      </Dialog>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-700">Failed to load ${name}.</p>
          <button onClick={refresh} className="text-sm text-red-700 underline">Retry</button>
        </div>
      )}

      {!loading && items.length === 0 ? (
        <EmptyState
          title="No ${name} yet"
          description="Create your first ${pascalSingular.toLowerCase()}."
          action={{ label: 'Create ${pascalSingular}', onClick: () => setCreateOpen(true) }}
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

        await writeFile(pagePath, pageContent, "utf-8");
        filesCreated.push(`src/app/dashboard/${name}/page.tsx`);
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
              ? [`Navigate to /dashboard/${name} to see the new page`]
              : [
                  `Run with add_page=true to scaffold a dashboard page at /dashboard/${name}`,
                ]),
          ],
        },
        `Added "${name}" collection: ${pascalSingular} type, ${camelPlural}() accessor, and ${hookName}() hook.${
          add_page
            ? ` Dashboard page created at src/app/dashboard/${name}/page.tsx.`
            : ""
        }`
      );
    }
  );
}

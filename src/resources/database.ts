export const DATABASE_REFERENCE = `
# Varity Database API Reference

## Installation & Import

\`\`\`typescript
import { db, Database, Collection } from '@varity-labs/sdk';
import type { QueryOptions, Document, CollectionResponse, DatabaseConfig } from '@varity-labs/sdk';
\`\`\`

## Zero-Config Setup

The \`db\` singleton auto-resolves its proxy URL from environment variables in this order:
1. \`NEXT_PUBLIC_VARITY_DB_PROXY_URL\` (Next.js)
2. \`VITE_VARITY_DB_PROXY_URL\` (Vite)
3. \`REACT_APP_VARITY_DB_PROXY_URL\` (CRA)
4. Falls back to \`https://varity.app\`

Auth token resolves from \`NEXT_PUBLIC_VARITY_APP_TOKEN\` / \`VITE_VARITY_APP_TOKEN\` / \`REACT_APP_VARITY_APP_TOKEN\`. If none is set, a shared dev token is generated automatically. No configuration needed during development.

> **Note on shared database log message:** During build and development, you may see:
> \`[Varity Database] Using shared development database. Data is stored in an isolated dev schema.\`
>
> This is normal — your data is isolated from other developers even though the database server is shared. In production (after \`varitykit app deploy\`), your app gets its own dedicated database.

## ⚠️ Important: All Filtering Is Client-Side

> **Architectural decision to understand before building:** The \`get()\` method returns documents from the database; all filtering, searching, and sorting beyond basic \`orderBy\` is done in your JavaScript code — not on the server.
>
> **What this means in practice:**
> - \`get()\` returns up to 1,000 documents. For collections larger than 1,000, use \`limit\`/\`offset\` pagination.
> - To find records matching a condition (e.g., "status === 'active'"), fetch the collection then call \`.filter()\` in JS.
> - For multi-user apps: store \`userId\` on each document at creation time, then filter by \`userId\` after fetching.
>
> **This is fine for most SaaS apps** — dashboards with hundreds to low-thousands of records work well. If you expect tens of thousands of rows and need server-side search, consider an external search service.
>
> See Example 4 (filtering in application code) and Example 5 (per-user scoping) for patterns.

## Core Types

\`\`\`typescript
interface Document {
  id: string;            // UUID, auto-generated
  created_at?: string;   // ISO timestamp
  updated_at?: string;   // ISO timestamp
  [key: string]: any;
}

interface QueryOptions {
  limit?: number;    // Max documents to return
  offset?: number;   // Skip N documents (pagination)
  orderBy?: string;  // "fieldName" for asc, "-fieldName" for desc
}

interface DatabaseConfig {
  proxyUrl?: string;   // DB proxy URL
  appToken?: string;   // JWT auth token
}

interface CollectionResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}
\`\`\`

## Class: Database

\`\`\`typescript
class Database {
  constructor(config?: Partial<DatabaseConfig>)
  collection<T = any>(name: string): Collection<T>
}
\`\`\`

- \`db\` is a pre-configured singleton: \`export const db = new Database();\`
- Use \`new Database({ proxyUrl, appToken })\` only for custom instances.

## Class: Collection<T>

All methods are async and throw on failure.

\`\`\`typescript
class Collection<T = any> {
  // Insert a document. Returns the inserted document with id and timestamps.
  async add(data: Partial<T>): Promise<T & Document>

  // Query documents. Always returns an array — never null.
  // Returns [] when no documents exist; only throws on network or permission failure.
  // ⚠️ Returns up to 1,000 documents per call. For collections larger than 1,000 documents,
  //    use limit/offset to paginate — see the pagination example in the Storage Limits section.
  async get(options?: QueryOptions): Promise<(T & Document)[]>

  // Update a document by ID. Returns the updated document.
  async update(id: string, data: Partial<T>): Promise<T & Document>

  // Delete a document by ID. Returns true on success.
  async delete(id: string): Promise<boolean>
}
\`\`\`

### HTTP Endpoints (internal)

- \`add\` -> \`POST /db/{collection}/add\`
- \`get\` -> \`GET /db/{collection}/get?limit=&offset=&orderBy=\`
- \`update\` -> \`PUT /db/{collection}/update/{id}\`
- \`delete\` -> \`DELETE /db/{collection}/delete/{id}\`

All requests include \`Authorization: Bearer <token>\` header.

## Collection Accessor Pattern

Define typed collection accessors in a \`lib/database.ts\` file:

\`\`\`typescript
import { db } from '@varity-labs/sdk';
import type { Project, Task, TeamMember } from '../types';

export const projects = () => db.collection<Project>('projects');
export const tasks = () => db.collection<Task>('tasks');
export const teamMembers = () => db.collection<TeamMember>('team_members');
\`\`\`

Each accessor returns a fresh Collection instance. Use arrow functions (not bare constants) so the collection is resolved on each call.

## React Hook Pattern

Wrap collections in hooks with useCallback, useState, useEffect for loading/error state and optimistic updates.

> **Note on \`fetchWithRetry\`:** The generated \`lib/hooks.ts\` includes a \`fetchWithRetry\` helper that retries failed network requests up to 3 times with 1500ms between attempts. It is used inside each hook's \`refresh()\` function. It is not part of the SDK — it lives in your project's \`lib/hooks.ts\` and can be adjusted directly there.

\`\`\`typescript
'use client';
import { useState, useEffect, useCallback } from 'react';
import { projects } from './database';
import type { Project } from '../types';

interface UseCollectionReturn<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  create: (item: any) => Promise<void>;
  update: (id: string, updates: Partial<T>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useProjects(): UseCollectionReturn<Project> {
  const [data, setData] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await projects().get();
      setData(result as Project[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (input: Omit<Project, 'id' | 'createdAt'>) => {
    const optimistic: Project = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    setData(prev => [optimistic, ...prev]);
    try {
      await projects().add({ ...input, createdAt: optimistic.createdAt });
      await refresh();
    } catch (err) {
      setData(prev => prev.filter(p => p.id !== optimistic.id));
      throw err;
    }
  };

  const update = async (id: string, updates: Partial<Project>) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    try {
      await projects().update(id, updates);
    } catch (err) {
      if (original) setData(prev => prev.map(p => p.id === id ? original : p));
      throw err;
    }
  };

  const remove = async (id: string) => {
    const original = data.find(p => p.id === id);
    setData(prev => prev.filter(p => p.id !== id));
    try {
      await projects().delete(id);
    } catch (err) {
      if (original) setData(prev => [...prev, original]);
      throw err;
    }
  };

  return { data, loading, error, create, update, remove, refresh };
}
\`\`\`

## Complete Examples

### Example 1: Basic CRUD

\`\`\`typescript
import { db } from '@varity-labs/sdk';

interface Product {
  name: string;
  price: number;
  category: string;
}

// Insert
const product = await db.collection<Product>('products').add({
  name: 'Widget',
  price: 29.99,
  category: 'tools'
});
// product.id -> "550e8400-..." (auto-generated UUID)

// Query all
const all = await db.collection<Product>('products').get();

// Query with pagination and sorting
const page = await db.collection<Product>('products').get({
  limit: 10,
  offset: 20,
  orderBy: '-price'  // descending by price
});

// Update
await db.collection<Product>('products').update(product.id, { price: 24.99 });

// Delete
await db.collection<Product>('products').delete(product.id);
\`\`\`

### Example 2: Client-Side Data Fetch with useEffect

> **Note: API routes are not supported with static export.** The Varity template uses \`output: 'export'\` in \`next.config.js\`, which disables \`app/api/\` routes and server-side rendering. Use client-side data access instead.

\`\`\`typescript
'use client';
import { useState, useEffect } from 'react';
import { db } from '@varity-labs/sdk';

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchOrders() {
      try {
        const result = await db.collection('orders').get({
          limit: 50,
          offset: 0,
          orderBy: '-created_at',
        });
        setOrders(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load orders');
      } finally {
        setLoading(false);
      }
    }
    fetchOrders();
  }, []);

  if (loading) return <p>Loading...</p>;
  if (error) return <p>Error: {error}</p>;
  return <ul>{orders.map(o => <li key={o.id}>{o.id}</li>)}</ul>;
}
\`\`\`

### Example 3: User Settings (query, create-if-missing, update)

\`\`\`typescript
import { db } from '@varity-labs/sdk';

const settingsCol = () => db.collection<UserSettings>('user_settings');

async function getOrCreateSettings(userId: string): Promise<UserSettings> {
  const all = await settingsCol().get();
  const existing = all.find(s => s.user_id === userId);
  if (existing) return existing;

  return await settingsCol().add({
    user_id: userId,
    theme: 'system',
    language: 'en',
    updated_at: new Date().toISOString(),
  });
}

async function updateSettings(id: string, updates: Partial<UserSettings>) {
  return await settingsCol().update(id, {
    ...updates,
    updated_at: new Date().toISOString(),
  });
}
\`\`\`

### Example 4: Filtering in Application Code

The database API returns all documents; filter client-side:

\`\`\`typescript
const allTasks = await db.collection<Task>('tasks').get();
const myTasks = allTasks.filter(t => t.assignee === currentUserId);
const urgent = allTasks.filter(t => t.priority === 'high' && t.status !== 'done');
\`\`\`

### Example 5: Filter by Current User (Most Common SaaS Pattern)

Scope any collection to the authenticated user by storing \`userId\` on each document and filtering client-side:

\`\`\`typescript
import { usePrivy } from '@varity-labs/ui-kit';
import { db } from '@varity-labs/sdk';

// When creating a record, store the user's ID
const { user } = usePrivy();
await db.collection('notes').add({
  title: 'My note',
  content: '...',
  userId: user.id,         // ← always tag with the owner
  createdAt: new Date().toISOString(),
});

// When reading, fetch all then filter to current user's records
const records = await db.collection('notes').get();
const myRecords = records.filter(r => r.userId === user.id);
\`\`\`

This pattern works for any per-user data: projects, settings, orders, notes, etc. The \`userId\` field is just a regular string — set it on \`add()\` and filter on \`get()\`.

### Example 6: Relating Two Collections (Joining)

When one collection stores a reference to another (e.g., a \`deal\` stores a \`clientId\`), fetch both collections and join them in application code:

\`\`\`typescript
import { useClients, useDeals } from '@/lib/hooks';

function DealsTable() {
  const { data: clients } = useClients();
  const { data: deals } = useDeals();

  // Build an ID → item lookup map for O(1) access
  const clientMap = Object.fromEntries(clients.map(c => [c.id, c]));

  return (
    <table>
      {deals.map(deal => (
        <tr key={deal.id}>
          <td>{deal.title}</td>
          {/* Display client name instead of raw UUID */}
          <td>{clientMap[deal.clientId]?.name ?? '—'}</td>
          <td>{deal.value}</td>
        </tr>
      ))}
    </table>
  );
}
\`\`\`

**Pattern:** fetch parent collection → build a \`{ [id]: item }\` lookup map → use the map to show the related record's name instead of a raw ID.

> **Auto-generated Select:** When you scaffold a page with \`varity_add_collection({ name: "deals", fields: [{ name: "clientId", type: "string" }], add_page: true })\`, the generated create dialog uses a \`<Select>\` dropdown populated by \`useClients()\` for any field ending in \`Id\`. Developers pick from a list of existing clients — no raw UUID entry required.

## Key Points

- **No schema definition needed.** Collections are created implicitly on first write.
- **All methods throw on failure.** Wrap in try/catch.
- **\`get()\` always returns an array.** An empty collection returns \`[]\` — never \`null\` or \`undefined\`. It throws only on a network error or permission failure. To distinguish "no records yet" from "failed to load", check the \`error\` state returned by the hook (\`error !== null\`), not the array length.
- **Server-side filtering is not supported.** Use \`get()\` then filter in JS. Use \`limit\`/\`offset\` for pagination, \`orderBy\` for sorting.
- **IDs are UUIDs.** Auto-generated by the proxy on \`add()\`.
- **Timestamps** (\`created_at\`, \`updated_at\`) are managed by the proxy.
- **Dev mode** uses a shared database with an isolated dev schema. Deploy with \`varitykit app deploy\` to get a private database.

## Storage Limits (Beta)

| Limit | Value | Notes |
|-------|-------|-------|
| Document size | 256 KB per document | Applies to a single \`add()\` or \`update()\` payload |
| Collection size | Unlimited documents | No per-collection row cap |
| \`get()\` result size | 1,000 documents per call | Use \`limit\`/\`offset\` to paginate beyond 1,000 |
| \`orderBy\` fields | 1 per query | Multi-field sort is not supported in beta |

> **Beta note:** These limits apply during the beta period. Post-beta limits will be published on the pricing page. If your use case requires higher limits today, reach out via [Discord](https://discord.gg/7vWsdwa2Bg).

If you hit the 1,000-document \`get()\` limit in a large collection, paginate with \`offset\`:

\`\`\`typescript
async function getAllDocuments<T>(collectionName: string): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const page = await db.collection<T>(collectionName).get({ limit, offset });
    results.push(...page);
    if (page.length < limit) break;  // last page
    offset += limit;
  }
  return results;
}
\`\`\`
`;

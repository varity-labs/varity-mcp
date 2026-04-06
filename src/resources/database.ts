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

  // Query documents. Returns an array (empty array if none found).
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

Wrap collections in hooks with useCallback, useState, useEffect for loading/error state and optimistic updates:

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

### Example 2: Next.js API Route

\`\`\`typescript
import { db } from '@varity-labs/sdk';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get('limit') || '50');
  const offset = Number(searchParams.get('offset') || '0');

  const orders = await db.collection('orders').get({ limit, offset, orderBy: '-created_at' });
  return Response.json(orders);
}

export async function POST(request: Request) {
  const body = await request.json();
  const order = await db.collection('orders').add(body);
  return Response.json(order, { status: 201 });
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

## Key Points

- **No schema definition needed.** Collections are created implicitly on first write.
- **All methods throw on failure.** Wrap in try/catch.
- **Server-side filtering is not supported.** Use \`get()\` then filter in JS. Use \`limit\`/\`offset\` for pagination, \`orderBy\` for sorting.
- **IDs are UUIDs.** Auto-generated by the proxy on \`add()\`.
- **Timestamps** (\`created_at\`, \`updated_at\`) are managed by the proxy.
- **Dev mode** uses a shared database with an isolated dev schema. Deploy with \`varitykit app deploy\` to get a private database.
`;

export const PATTERNS_REFERENCE = `
# Varity SaaS Template -- Architecture & Patterns

## Project File Structure

\`\`\`
src/
  app/
    layout.tsx              # Root layout: <html>, <body>, <Providers>
    page.tsx                # Landing page (public, no auth)
    login/page.tsx          # Login page with PrivyStack
    not-found.tsx           # Custom 404
    globals.css             # Tailwind base styles
    dashboard/
      layout.tsx            # Auth-protected shell: PrivyStack > PrivyProtectedRoute > DashboardShell
      page.tsx              # Dashboard home: KPIs, getting-started checklist, quick actions
      projects/page.tsx     # Full CRUD: list + detail view with nested tasks
      tasks/page.tsx        # Cross-project task list with status cycling + filters
      team/page.tsx         # Team member management (invite, role change, remove)
      settings/page.tsx     # User preferences (theme, notifications, privacy)
  components/
    providers.tsx           # Global providers (ToastProvider only -- no auth at root)
    dashboard/              # DashboardStats, RecentActivity
    landing/                # Hero, Features, Pricing, HowItWorks, CTA, Testimonials
    shared/                 # Navbar, Footer
  lib/
    varity.ts               # Single re-export: \`export { db } from '@varity-labs/sdk'\`
    database.ts             # Typed collection accessors (projects, tasks, teamMembers, userSettings)
    hooks.ts                # React hooks: useProjects, useTasks, useTeam, useUserSettings, useCurrentUser
    constants.ts            # APP_NAME, NAVIGATION_ITEMS, status/priority/role option arrays
    utils.ts                # formatDate, formatDateShort, formatRelativeDate, cn, downloadCSV, isValidEmail
  services/
    dashboardService.ts     # REST API client (optional, not used by default CRUD)
  types/
    index.ts                # Project, Task, TeamMember, UserSettings interfaces
.env.example                # Zero-config env vars (all optional for dev)
next.config.js              # Static export, unoptimized images, trailing slash
package.json                # @varity-labs/sdk, @varity-labs/ui-kit, @varity-labs/types, next, react, lucide-react
\`\`\`

## Data Layer Chain

The template uses a 3-file chain for all data access:

**Step 1: lib/varity.ts** -- SDK entry point
\`\`\`ts
export { db } from '@varity-labs/sdk';
\`\`\`

**Step 2: lib/database.ts** -- Typed collection accessors
\`\`\`ts
import { db } from './varity';
import type { Project, Task, TeamMember, UserSettings } from '../types';

export const projects    = () => db.collection<Project>('projects');
export const tasks       = () => db.collection<Task>('tasks');
export const teamMembers = () => db.collection<TeamMember>('team_members');
export const userSettings = () => db.collection<UserSettings>('user_settings');
\`\`\`

**Step 3: lib/hooks.ts** -- React hooks with optimistic updates
\`\`\`ts
import { projects, tasks } from './database';

// Each hook returns: { data, loading, error, create, update, remove, refresh }
export function useProjects(): UseCollectionReturn<Project> { ... }
export function useTasks(projectId?: string): UseCollectionReturn<Task> { ... }
export function useTeam(): UseCollectionReturn<TeamMember> { ... }
export function useUserSettings() { ... }
export function useCurrentUser() { ... }
\`\`\`

Hooks use optimistic updates: UI updates immediately, rolls back on error.

## Type Definitions (types/index.ts)

\`\`\`ts
export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  owner: string;
  members: string[];
  dueDate: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  assignee?: string;
  dueDate?: string;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  avatarUrl?: string;
  joinedAt: string;
}

export interface UserSettings {
  id: string;
  user_id: string;
  theme: 'light' | 'dark' | 'system';
  email_notifications: boolean;
  marketing_emails: boolean;
  product_updates: boolean;
  date_format: string;
  timezone: string;
  language: string;
  dashboard_layout: 'comfortable' | 'compact';
  two_factor_enabled: boolean;
  analytics_enabled: boolean;
  cookies_enabled: boolean;
  updated_at: string;
}
\`\`\`

## CRUD Page Pattern

Every CRUD page follows this structure (extracted from projects/page.tsx):

\`\`\`tsx
'use client';

import { useState } from 'react';
import { DataTable, EmptyState, KPICard } from '@varity-labs/ui-kit';
import { Button, Input, Textarea, Select, Dialog, ConfirmDialog, useToast } from '@varity-labs/ui-kit';
import { useProjects, useCurrentUser } from '@/lib/hooks';
import { PRIORITY_OPTIONS, PROJECT_STATUS_OPTIONS } from '@/lib/constants';
import { formatDate, downloadCSV } from '@/lib/utils';
import type { Project } from '@/types';

const EMPTY_FORM = { name: '', description: '', status: 'active' as Project['status'] };

export default function MyPage() {
  const toast = useToast();
  const { email } = useCurrentUser();
  const { data: items, loading, error, create, update, remove, refresh } = useProjects();

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  // Create handler
  async function handleCreate() {
    if (!form.name.trim()) return;
    setSubmitting(true);
    try {
      await create({ name: form.name.trim(), ...otherFields });
      toast.success('Created successfully');
      setCreateOpen(false);
    } catch {
      toast.error('Failed to create');
    } finally {
      setSubmitting(false);
    }
  }

  // Table columns
  const columns = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'status', header: 'Status', render: (v: string) => <StatusBadge status={v} /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header with title + action button */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Items</h1>
          <p className="mt-1 text-sm text-gray-600">Description here.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} icon={<Plus className="h-4 w-4" />}>New Item</Button>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create Item">
        <div className="space-y-4">
          <Input label="Name" required value={form.name} onChange={...} />
          <Button onClick={handleCreate} loading={submitting}>Create</Button>
        </div>
      </Dialog>

      {/* Error banner with retry */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-700">Failed to load.</p>
          <button onClick={refresh} className="underline">Retry</button>
        </div>
      )}

      {/* Empty state or data table */}
      {!loading && items.length === 0 ? (
        <EmptyState title="No items yet" description="Create your first item." action={{ label: 'Create', onClick: () => setCreateOpen(true) }} />
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <DataTable columns={columns} data={items} loading={loading} pagination pageSize={10} hoverable />
        </div>
      )}
    </div>
  );
}
\`\`\`

## Dashboard Layout & Auth

\`\`\`tsx
// dashboard/layout.tsx wraps all /dashboard/* pages
export default function DashboardRootLayout({ children }) {
  return (
    <PrivyStack
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
      thirdwebClientId={process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID}
      loginMethods={['email', 'google']}
      appearance={{ theme: 'light', accentColor: '#2563EB', logo: '/logo.svg' }}
    >
      <PrivyProtectedRoute fallback={<RedirectToLogin />}>
        <DashboardShell>{children}</DashboardShell>
      </PrivyProtectedRoute>
    </PrivyStack>
  );
}
\`\`\`

Auth is ONLY loaded in the dashboard layout, not at the root. The landing page loads instantly.

## Providers Pattern (components/providers.tsx)

\`\`\`tsx
'use client';
import { ReactNode } from 'react';
import { ToastProvider } from '@varity-labs/ui-kit';

export function Providers({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
\`\`\`

Root layout uses \`<Providers>\` for global toast. Auth (PrivyStack) is only in dashboard/layout.tsx.

## next.config.js Required Settings

\`\`\`js
const nextConfig = {
  output: 'export',               // Static export for Varity hosting
  images: { unoptimized: true },   // Required for static export
  trailingSlash: true,             // Required for static file hosting
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  webpack: (config, { isServer, dev }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,  // Suppress MetaMask warning
    };
    if (!dev && !isServer) {
      config.devtool = false;  // Avoid 35MB eval-source-map chunks
    }
    return config;
  },
};
\`\`\`

All three settings (\`output: 'export'\`, \`images: { unoptimized: true }\`, \`trailingSlash: true\`) are required.

## Environment Variables (.env.example)

\`\`\`
# ZERO CONFIG: Leave everything blank! Auth and database work immediately
# using shared development credentials. No setup required.
# For production: varitykit app deploy injects all credentials automatically.

NEXT_PUBLIC_PRIVY_APP_ID=           # Auth (optional -- dev credentials auto-used)
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=     # Auth (optional -- dev credentials auto-used)
NEXT_PUBLIC_VARITY_APP_TOKEN=       # Database (optional -- dev database auto-used)
NEXT_PUBLIC_VARITY_APP_ID=          # App ID (generated by varitykit app deploy)
\`\`\`

## Key Dependencies (package.json)

\`\`\`json
{
  "dependencies": {
    "@varity-labs/sdk": "^2.0.0-beta.3",
    "@varity-labs/types": "^2.0.0-beta.3",
    "@varity-labs/ui-kit": "^2.0.0-beta.6",
    "lucide-react": "^0.400.0",
    "next": "^15.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.0",
    "typescript": "^5.0.0",
    "autoprefixer": "^10.0.0",
    "postcss": "^8.0.0"
  }
}
\`\`\`

## Constants Pattern (lib/constants.ts)

\`\`\`ts
import type { NavigationItem } from '@varity-labs/ui-kit';

export const APP_NAME = 'TaskFlow';

export const NAVIGATION_ITEMS: NavigationItem[] = [
  { label: 'Dashboard', icon: 'dashboard', path: '/dashboard' },
  { label: 'Projects',  icon: 'folder',    path: '/dashboard/projects' },
  { label: 'Tasks',     icon: 'list',      path: '/dashboard/tasks' },
  { label: 'Team',      icon: 'people',    path: '/dashboard/team' },
  { label: 'Settings',  icon: 'settings',  path: '/dashboard/settings' },
];

export const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export const TASK_STATUS_OPTIONS = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
] as const;

export const PROJECT_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
] as const;
\`\`\`

## UI Kit Components Used

From \`@varity-labs/ui-kit\`:
- Layout: \`DashboardLayout\`, \`CommandPalette\`
- Data: \`DataTable\`, \`KPICard\`, \`EmptyState\`
- Forms: \`Button\`, \`Input\`, \`Textarea\`, \`Select\`
- Feedback: \`Dialog\`, \`ConfirmDialog\`, \`useToast\`, \`ToastProvider\`
- Badges: \`ProjectStatusBadge\`, \`TaskStatusBadge\`, \`PriorityBadge\`
- Auth: \`PrivyStack\`, \`PrivyProtectedRoute\`, \`usePrivy\`

Icons come from \`lucide-react\` (Plus, Pencil, Trash2, Download, FolderKanban, etc).
`;

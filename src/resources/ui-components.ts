export const UI_COMPONENTS_REFERENCE = `
# Varity UI Components Reference (@varity-labs/ui-kit)

All imports: \`import { ComponentName } from '@varity-labs/ui-kit'\`

---

## FORM COMPONENTS

### Button
\`\`\`tsx
<Button variant="primary" size="md" loading={false} icon={<Icon />} disabled={false}>
  Click Me
</Button>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| variant | 'primary' \\| 'secondary' \\| 'outline' \\| 'ghost' \\| 'danger' | 'primary' |
| size | 'sm' \\| 'md' \\| 'lg' | 'md' |
| loading | boolean | false |
| icon | ReactNode | - |
| ...rest | ButtonHTMLAttributes | - |

### Input
\`\`\`tsx
<Input label="Email" error="Required" hint="We'll never share it" required />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| label | string? | - |
| error | string? | - |
| hint | string? | - |
| ...rest | InputHTMLAttributes | - |

### Textarea
\`\`\`tsx
<Textarea label="Description" error="Too short" rows={4} />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| label | string? | - |
| error | string? | - |
| ...rest | TextareaHTMLAttributes | - |

### Select
\`\`\`tsx
<Select label="Status" options={[{ value: 'active', label: 'Active' }]} error="Required" />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| label | string? | - |
| error | string? | - |
| options | { value: string; label: string }[] | required |
| ...rest | SelectHTMLAttributes | - |

### Toggle
\`\`\`tsx
<Toggle checked={on} onChange={setOn} label="Dark mode" description="Enable dark theme" size="md" />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| checked | boolean | required |
| onChange | (checked: boolean) => void | required |
| label | ReactNode? | - |
| description | string? | - |
| disabled | boolean | false |
| size | 'sm' \\| 'md' | 'md' |

### Checkbox
\`\`\`tsx
<Checkbox checked={val} onChange={setVal} label="Accept terms" description="..." indeterminate={false} error="Required" />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| checked | boolean | required |
| onChange | (checked: boolean) => void | required |
| label | string? | - |
| description | string? | - |
| disabled | boolean | false |
| indeterminate | boolean | false |
| error | string? | - |

### RadioGroup
\`\`\`tsx
<RadioGroup
  value={selected}
  onChange={setSelected}
  name="plan"
  label="Choose plan"
  options={[
    { value: 'free', label: 'Free', description: '0/mo' },
    { value: 'pro', label: 'Pro', description: '$10/mo', disabled: false },
  ]}
  orientation="vertical"
  error="Please select"
/>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| value | string | required |
| onChange | (value: string) => void | required |
| options | RadioOption[] | required |
| name | string | required |
| label | string? | - |
| orientation | 'vertical' \\| 'horizontal' | 'vertical' |
| disabled | boolean | false |
| error | string? | - |

RadioOption: \`{ value: string; label: string; description?: string; disabled?: boolean }\`

---

## DISPLAY COMPONENTS

### Badge
\`\`\`tsx
<Badge variant="green" dot>Active</Badge>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| variant | 'green' \\| 'blue' \\| 'yellow' \\| 'red' \\| 'gray' | 'gray' |
| dot | boolean | false |
| children | ReactNode | required |

**Preset badges:** \`PriorityBadge({ priority })\`, \`ProjectStatusBadge({ status })\`, \`TaskStatusBadge({ status })\`, \`RoleBadge({ role })\` - auto-map to colors.

### Avatar / AvatarGroup
\`\`\`tsx
<Avatar name="John Doe" src="/avatar.jpg" size="md" status="online" />
<AvatarGroup avatars={[{ name: 'A', src: '...' }]} max={3} size="md" />
\`\`\`
Avatar props: \`name\` (required), \`src?\`, \`alt?\`, \`size: 'sm'|'md'|'lg'\`, \`status: 'online'|'offline'|'busy'\`.
AvatarGroup props: \`avatars: { src?; name }[]\`, \`max: number (3)\`, \`size\`.

### ProgressBar
\`\`\`tsx
<ProgressBar value={75} variant="success" size="md" showValue striped label="Upload progress" />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| value | number (0-100) | required |
| variant | 'primary' \\| 'success' \\| 'warning' \\| 'danger' | 'primary' |
| size | 'sm' \\| 'md' | 'md' |
| showValue | boolean | false |
| striped | boolean | false |
| label | string? | - |

---

## OVERLAY COMPONENTS

### Dialog
\`\`\`tsx
<Dialog open={isOpen} onClose={() => setOpen(false)} title="Edit Item" description="Optional subtitle">
  <form>...</form>
</Dialog>
\`\`\`
| Prop | Type |
|------|------|
| open | boolean |
| onClose | () => void |
| title | string |
| description | string? |
| children | ReactNode |

Features: focus trap, Escape to close, backdrop click to close, body scroll lock.

### ConfirmDialog
\`\`\`tsx
<ConfirmDialog
  open={showDelete}
  onClose={() => setShowDelete(false)}
  onConfirm={handleDelete}
  title="Delete project?"
  description="This cannot be undone."
  confirmLabel="Delete"
  confirmVariant="danger"
  loading={isDeleting}
/>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| open | boolean | - |
| onClose | () => void | - |
| onConfirm | () => void | - |
| title | string | - |
| description | string | - |
| confirmLabel | string | 'Delete' |
| confirmVariant | 'danger' \\| 'primary' | 'danger' |
| loading | boolean | false |

### DropdownMenu
\`\`\`tsx
<DropdownMenu
  trigger={<button><MoreHorizontal /></button>}
  align="right"
  items={[
    { label: 'Edit', onClick: edit, icon: Pencil },
    'divider',
    { label: 'Delete', onClick: del, icon: Trash, danger: true },
  ]}
/>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| trigger | ReactNode | required |
| items | (DropdownMenuItem \\| 'divider')[] | required |
| align | 'left' \\| 'right' | 'right' |

DropdownMenuItem: \`{ label: string; onClick: () => void; icon?: LucideIcon; disabled?: boolean; danger?: boolean }\`

---

## FEEDBACK COMPONENTS

### ToastProvider + useToast
\`\`\`tsx
// Wrap app once:
<ToastProvider>{children}</ToastProvider>

// Use anywhere inside:
const toast = useToast();
toast.success('Saved!');
toast.error('Failed to save');
toast.info('Processing...');
\`\`\`
ToastContextValue: \`{ success(msg); error(msg); info(msg) }\`

### Skeleton
\`\`\`tsx
<Skeleton variant="rectangle" width="100%" height={20} />
<Skeleton variant="circle" width={40} />
<Skeleton variant="text" lines={3} />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| variant | 'rectangle' \\| 'circle' \\| 'text' | 'rectangle' |
| width | string \\| number? | - |
| height | string \\| number? | - |
| lines | number | 3 (text only) |

---

## NAVIGATION COMPONENTS

### CommandPalette
\`\`\`tsx
<CommandPalette
  open={isOpen}
  onClose={() => setOpen(false)}
  onNavigate={(path) => router.push(path)}
  projects={projectsData}
  tasks={tasksData}
  team={teamData}
/>
\`\`\`
| Prop | Type |
|------|------|
| open | boolean |
| onClose | () => void |
| onNavigate | (path: string) => void |
| projects | { id; name; description?; status? }[]? |
| tasks | { id; title; description?; status? }[]? |
| team | { id; name; email }[]? |

Trigger with Cmd+K / Ctrl+K. Searches across navigation, projects, tasks, team.

### Breadcrumb
\`\`\`tsx
<Breadcrumb
  items={[
    { label: 'Projects', onClick: () => nav('/projects') },
    { label: 'My Project' },
  ]}
  separator="chevron"
  showHome
  onHomeClick={() => nav('/dashboard')}
/>
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| items | { label: string; href?; onClick? }[] | required |
| separator | 'chevron' \\| 'slash' | 'chevron' |
| showHome | boolean | true |
| onHomeClick | () => void? | - |

---

## DASHBOARD COMPONENTS

### DashboardLayout
\`\`\`tsx
<DashboardLayout
  companyName="Acme Corp"
  logoUrl="/logo.png"
  navigationItems={[
    { label: 'Dashboard', icon: 'dashboard', path: '/', active: true },
    { label: 'Analytics', icon: 'analytics', path: '/analytics', children: [...] },
  ]}
  user={{ name: 'John', address: 'john@example.com', avatarUrl: '/avatar.png' }}
  onLogout={handleLogout}
  onNavigate={(path) => router.push(path)}
  onSearchClick={() => setCommandPaletteOpen(true)}
  searchPlaceholder="Search..."
  showSidebar showHeader showFooter
  sidebarWidth={240} headerHeight={64}
>
  <Content />
</DashboardLayout>
\`\`\`
Includes DashboardHeader, DashboardSidebar, DashboardFooter. NavigationItem supports nested \`children\`.
UserInfo: \`{ name: string; address: string; avatarUrl?: string }\`.

### KPICard
\`\`\`tsx
<KPICard title="Revenue" value="$12,345" trend="up" trendValue="+12%" icon={<DollarSign />}
  subtitle="Monthly recurring" variant="default" size="md" loading={false} onClick={() => {}} />
\`\`\`
| Prop | Type | Default |
|------|------|---------|
| title | string | required |
| value | string \\| number | required |
| subtitle | string? | - |
| icon | ReactNode? | - |
| trend | 'up' \\| 'down' \\| 'neutral'? | - |
| trendValue | string? | - |
| loading | boolean | false |
| onClick | () => void? | - |
| variant | 'default' \\| 'outlined' \\| 'filled' | 'default' |
| size | 'sm' \\| 'md' \\| 'lg' | 'md' |

### StatusBadge / IntegrationStatus
\`\`\`tsx
<StatusBadge status="connected" showDot size="md" />
<IntegrationStatus isConnected={true} isSyncing={false} needsReauth={false} lastSyncTime={new Date()} />
\`\`\`
StatusType: 'connected' | 'disconnected' | 'pending' | 'syncing' | 'error' | 'warning' | 'expired' | 'active' | 'inactive'.

### EmptyState
\`\`\`tsx
<EmptyState title="No projects" description="Get started by creating one."
  icon={<FolderIcon />}
  action={{ label: 'Create Project', onClick: () => {} }}
  secondaryAction={{ label: 'Import', onClick: () => {} }}
  size="md" />
\`\`\`
Presets: \`EmptyStatePresets.NoResults\`, \`.NoData\`, \`.NoIntegrations\`, \`.ConnectionRequired\`, \`.ComingSoon\`.

### LoadingSkeleton
\`\`\`tsx
<LoadingSkeleton type="card" />
<LoadingSkeleton type="table" items={5} />
<LoadingSkeleton type="list" items={3} />
<LoadingSkeleton type="text" lines={3} />
\`\`\`
type: 'text' | 'circle' | 'rect' | 'card' | 'table' | 'list'. Shorthand components: \`SkeletonText\`, \`SkeletonCard\`, \`SkeletonTable\`, \`SkeletonList\`.

---

## ANALYTICS COMPONENTS

### DataTable
\`\`\`tsx
<DataTable
  columns={[
    { key: 'name', header: 'Name', sortable: true },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (val) => \\\`$\\\${val}\\\` },
    { key: 'status', header: 'Status', render: (_, row) => <Badge>{row.status}</Badge> },
  ]}
  data={items}
  pagination
  pageSize={10}
  onRowClick={(row) => router.push(\\\`/items/\\\${row.id}\\\`)}
  emptyMessage="No items found"
  hoverable
  striped
  loading={isLoading}
/>
\`\`\`
DataTableColumn: \`{ key: string; header: string; width?; sortable?: boolean; render?: (value, row) => ReactNode; align?: 'left'|'center'|'right' }\`.

Also exported: \`AnalyticsCard\`, \`ChartContainer\`, \`MetricDisplay\`, \`Sparkline\`, \`EnhancedKPICard\`.

---

## HOOKS

| Hook | Return | Description |
|------|--------|-------------|
| useToast() | { success, error, info } | Show toast notifications (must be inside ToastProvider) |
| useTheme() | theme context | Theme management (from Branding/ThemeProvider) |
| usePrivy() | { ready, authenticated, user, login, logout } | Auth state (re-export from @privy-io/react-auth) |
| useWallets() | { wallets } | Connected wallets (re-export) |
| useLogin() | login helpers | Login utilities (re-export) |
| useLogout() | logout helpers | Logout utilities (re-export) |
`;

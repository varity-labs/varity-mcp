export const AUTH_REFERENCE = `
# Varity Auth API Reference (@varity-labs/ui-kit)

> ## ⚠️ IMPORTANT: You are building a normal web app — not a crypto app
>
> The auth components in this reference are named \`PrivyStack\`, \`usePrivy()\`, etc. because Varity uses
> **Privy** as its internal authentication service provider — similar to how apps use Stripe internally
> for payments without exposing Stripe internals to end users.
>
> **What this means for you:**
> - ✅ Your users log in with **email, Google, or GitHub** — they see zero crypto concepts
> - ✅ You never sign up for Privy, never visit privy.io, never manage any Privy credentials
> - ✅ Component names like \`PrivyStack\` are Varity's internal API — they are just React components
> - ✅ \`NEXT_PUBLIC_PRIVY_APP_ID\` is a Varity-managed credential, auto-injected by \`varitykit app deploy\`
> - ❌ Do NOT Google "Privy" expecting to find Varity docs — Privy is an infrastructure vendor, not your product
>
> **If a colleague asks "why is Privy in our dependencies?":**
> "Varity uses Privy as its auth infrastructure — similar to using Firebase Auth or Auth0 under the hood.
> Our users see normal email/Google login. We don't manage any Privy accounts or credentials."

> **Summary:** Privy is the authentication service Varity uses internally. You do not need to sign up for
> Privy or manage credentials — Varity handles this entirely. During development, shared dev credentials are
> used automatically (zero config). In production, \`varitykit app deploy\` injects the correct credentials automatically.

All imports from \`@varity-labs/ui-kit\` unless noted. Privy hooks re-exported from \`@privy-io/react-auth\`.

## Which Provider Should I Use?

| Situation | Use This |
|-----------|----------|
| **New app (recommended for most cases)** | \`PrivyStack\` — handles everything automatically |
| **Full dashboard with custom error screens** | \`VarityDashboardProvider\` — adds error boundary control |
| **Need manual React Query control** | \`VarityPrivyProvider\` — lower-level, no PrivyReadyGate |

**In practice:** Use \`PrivyStack\` for 95% of apps. Switch to \`VarityDashboardProvider\` only if you need a custom error boundary or timeout screen at the provider level. Use \`VarityPrivyProvider\` only if you need to manage React Query yourself.

## Provider Hierarchy (Production Pattern)

\`\`\`
QueryClientProvider
  PrivyProvider          ← authentication layer
    PrivyReadyGate       ← prevents blank screen during init
      YourApp
\`\`\`

PrivyStack wraps all of this into a single component. Use PrivyStack for new apps.

## PrivyStack (Recommended)

All-in-one provider. Wraps Privy + React Query + PrivyReadyGate.

> **For standard SaaS apps (email/social login):** Use the simple setup below — no extra configuration needed.

\`\`\`tsx
import { PrivyStack } from '@varity-labs/ui-kit';

// Standard SaaS setup — email + Google login
<PrivyStack
  appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}  // optional — falls back to VARITY_DEV_CREDENTIALS
  loginMethods={['email', 'google']}
  appearance={{
    theme: 'light',           // 'light' | 'dark'
    accentColor: '#2563EB',   // hex string
    logo: '/logo.svg',        // optional logo URL
  }}
>
  <App />
</PrivyStack>
\`\`\`

**Props (PrivyStackProps):**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| appId | string? | VARITY_DEV_CREDENTIALS | Privy app ID (optional in dev) |
| children | ReactNode | required | App content |
| loginMethods | Array<'email'|'google'|'twitter'|'discord'|'github'|'apple'|'linkedin'|'sms'>? | ['email','google'] | Login methods to show |
| appearance | { theme?, accentColor?, logo? }? | { theme:'light', accentColor:'#2563EB' } | UI customization |

**Dev credentials auto-config:** When appId is omitted or empty, PrivyStack uses shared Varity dev credentials automatically via \`resolveCredentials()\` from \`@varity-labs/sdk\`. No .env setup needed for development.

## VarityPrivyProvider (Lower-level)

Wraps Privy + React Query. Does NOT include PrivyReadyGate (you may get a blank screen).

\`\`\`tsx
import { VarityPrivyProvider } from '@varity-labs/ui-kit';

<VarityPrivyProvider
  appId="your-privy-app-id"   // REQUIRED
  onLoginSuccess={(user) => {}}
  onLoginError={(error) => {}}
  appearance={{ theme: 'light', accentColor: '#6366f1', logo: '/logo.png' }}
>
  <App />
</VarityPrivyProvider>
\`\`\`

**Props (VarityPrivyProviderProps):**
| Prop | Type | Required | Description |
|------|------|----------|-------------|
| children | ReactNode | yes | App content |
| appId | string | yes | Privy app ID |
| onLoginSuccess | (user: User) => void | no | Login success callback |
| onLoginError | (error: Error) => void | no | Login error callback |
| appearance | { theme?, accentColor?, logo? } | no | UI customization |

## VarityDashboardProvider (Full Dashboard Setup)

Combines Privy + React Query + PrivyReadyGate + error screens. Requires explicit credentials (no auto-config fallback).

> **Why no auto-config?** \`VarityDashboardProvider\` is designed for production dashboards where you want full control over credential injection and error boundaries. Automatic credential fallback is intentionally omitted so that a missing \`privyAppId\` fails loudly (rather than silently using shared dev credentials in production). For development and most apps, use \`PrivyStack\` — it has auto-config built in.

\`\`\`tsx
import { VarityDashboardProvider } from '@varity-labs/ui-kit';

<VarityDashboardProvider
  privyAppId="..."
  loginMethods={['email', 'google']}
  appearance={{ theme: 'light', accentColor: '#2563EB', logo: '/logo.png' }}
  initTimeout={10000}
  errorBoundary={MyErrorBoundary}
>
  <Dashboard />
</VarityDashboardProvider>
\`\`\`

## Template Hooks

The Varity SaaS template generates helper hooks in \`lib/hooks.ts\` (not part of \`@varity-labs/ui-kit\`). These are convenience wrappers around \`usePrivy()\` for common patterns.

### useCurrentUser()

> ⚠️ **Import from \`@/lib/hooks\`, not \`@varity-labs/ui-kit\`** — \`useCurrentUser()\` is generated into \`lib/hooks.ts\` by \`varity_init\`. Searching \`@varity-labs/ui-kit\` for this hook will return nothing. For projects scaffolded with \`varity_init\`, always import from \`@/lib/hooks\`. For projects not using \`varity_init\`, copy the implementation at the bottom of this section into your own \`lib/hooks.ts\`.

Returns the currently authenticated user in a simplified, framework-friendly shape.

\`\`\`tsx
// lib/hooks.ts (generated by the template — not from @varity-labs/ui-kit)
import { useCurrentUser } from '@/lib/hooks';

const { id, email, name, authenticated, logout } = useCurrentUser();
\`\`\`

**Return values:**
| Field | Type | Description |
|-------|------|-------------|
| \`id\` | \`string \| null\` | Unique user ID (Privy DID) |
| \`email\` | \`string \| null\` | User's email address |
| \`name\` | \`string \| null\` | Display name (derived from email or social account) |
| \`authenticated\` | \`boolean\` | \`true\` if the user is logged in |
| \`logout\` | \`() => Promise<void>\` | Logs the user out |

**Example usage:**
\`\`\`tsx
function Header() {
  const { name, authenticated, logout } = useCurrentUser();

  if (!authenticated) return <LoginButton />;
  return (
    <div>
      <span>Hello, {name}</span>
      <button onClick={logout}>Sign out</button>
    </div>
  );
}
\`\`\`

> **Note:** For projects not using \`varity_init\`, copy the implementation below into your own \`lib/hooks.ts\`.

**Full implementation (copy this into \`lib/hooks.ts\` for projects not using \`varity_init\`):**

\`\`\`tsx
'use client';

import { usePrivy } from '@varity-labs/ui-kit';

/**
 * useCurrentUser — simplified user hook for dashboard patterns.
 * Import from '@/lib/hooks' — NOT from '@varity-labs/ui-kit'.
 */
export function useCurrentUser() {
  const { user, authenticated, logout } = usePrivy();

  // Extract email from any login method (email, Google, GitHub, etc.)
  const email =
    user?.email?.address ||
    user?.google?.email ||
    user?.github?.email ||
    user?.linkedAccounts?.find((a: any) => a.address && a.type === 'email')?.address ||
    user?.linkedAccounts?.find((a: any) => a.email)?.email ||
    '';

  const name = email ? email.split('@')[0] : 'User';

  return {
    id: user?.id || null,
    email,
    name,
    authenticated,
    logout,
  };
}
\`\`\`

## usePrivy() Hook

Re-exported from \`@privy-io/react-auth\`. Must be inside a Privy provider.

\`\`\`tsx
import { usePrivy } from '@varity-labs/ui-kit';

const { ready, authenticated, user, login, logout } = usePrivy();
\`\`\`

**Key return values:**
- \`ready: boolean\` — true once Privy has initialized
- \`authenticated: boolean\` — true if user is logged in
- \`user: User | null\` — user object with linked accounts
- \`login: () => Promise<void>\` — opens Privy login modal
- \`logout: () => Promise<void>\` — logs user out

**Extracting user email:**
\`\`\`tsx
const email = user?.email?.address;
const google = user?.google?.email;
const displayName = email?.split('@')[0] || 'User';
\`\`\`

**About \`user.linkedAccounts\`:**

\`user.linkedAccounts\` is an array of every login method the user has connected (email, Google, GitHub, etc.). Each entry has a \`type\` field and method-specific fields. You rarely need to access it directly — use the convenience accessors instead:

\`\`\`tsx
// Preferred: direct accessors
const email = user?.email?.address;          // email login
const googleEmail = user?.google?.email;     // Google login
const githubUsername = user?.github?.username; // GitHub login

// Advanced: iterate all linked accounts
user?.linkedAccounts.forEach(account => {
  if (account.type === 'email') console.log(account.address);
  if (account.type === 'google_oauth') console.log(account.email);
});
\`\`\`

Use \`linkedAccounts\` when you need to: check if the user has linked a specific login method, display a list of their connected accounts in settings, or handle a user who signed up with Google but later added email login.

Also re-exported: \`useLogin\`, \`useLogout\`.

## PrivyProtectedRoute

Guards content behind authentication. Shows fallback or default login prompt when not authenticated.

\`\`\`tsx
import { PrivyProtectedRoute } from '@varity-labs/ui-kit';

<PrivyProtectedRoute
  fallback={<RedirectToLogin />}     // optional — shown when not authenticated
  loadingComponent={<MySpinner />}   // optional — shown during Privy init
>
  <ProtectedContent />
</PrivyProtectedRoute>
\`\`\`

**Props (PrivyProtectedRouteProps):**
| Prop | Type | Description |
|------|------|-------------|
| children | ReactNode | Protected content |
| fallback | ReactNode? | Shown when not authenticated (default: built-in login prompt) |
| loadingComponent | ReactNode? | Shown during initialization (default: spinner) |

## PrivyLoginButton

Triggers Privy login modal. Auto-disables when loading or already authenticated.

\`\`\`tsx
import { PrivyLoginButton } from '@varity-labs/ui-kit';

<PrivyLoginButton
  onSuccess={(user) => console.log('Logged in:', user)}
  onError={(error) => console.error(error)}
  className="custom-button-classes"
>
  Sign In
</PrivyLoginButton>
\`\`\`

**Props (PrivyLoginButtonProps):**
| Prop | Type | Description |
|------|------|-------------|
| onSuccess | (user: User) => void? | Called after successful login |
| onError | (error: Error) => void? | Called on login failure |
| className | string? | Tailwind classes (has sensible default) |
| children | ReactNode? | Button text (default: "Sign In with Email or Social") |

## PrivyUserProfile

Displays user info: email address, social account, account type, join date. Returns null when not authenticated.

\`\`\`tsx
import { PrivyUserProfile } from '@varity-labs/ui-kit';

<PrivyUserProfile
  showLogoutButton={true}
  onLogout={() => router.push('/')}
  className="max-w-md"
/>
\`\`\`

**Props (PrivyUserProfileProps):**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| showLogoutButton | boolean? | true | Show logout button |
| onLogout | () => void? | - | Post-logout callback |
| className | string? | styled default | Container classes |

## PrivyReadyGate

Prevents blank screen during Privy initialization (5-15s). Shows loading screen, then timeout screen with retry.

\`\`\`tsx
import { PrivyReadyGate } from '@varity-labs/ui-kit';

<PrivyReadyGate
  timeout={10000}                              // ms before timeout screen (default: 10000)
  initializingScreen={<CustomLoader />}        // optional custom loading
  timeoutScreen={<CustomTimeout />}            // optional custom timeout
>
  <App />
</PrivyReadyGate>
\`\`\`

## InitializingScreen / InitTimeoutScreen

Standalone screens used by PrivyReadyGate. Can be used independently.

\`\`\`tsx
import { InitializingScreen, InitTimeoutScreen } from '@varity-labs/ui-kit';

<InitializingScreen
  title="Setting up..."
  description="Loading your data."
  steps={['Connecting', 'Loading profile', 'Preparing dashboard']}
/>

<InitTimeoutScreen
  onRetry={() => window.location.reload()}
  title="Still loading..."
  tips={['Check your connection', 'Try refreshing']}
/>
\`\`\`

## Production Auth Pattern (from SaaS Template)

\`\`\`tsx
// app/dashboard/layout.tsx
import { PrivyStack, PrivyProtectedRoute } from '@varity-labs/ui-kit';

export default function DashboardLayout({ children }) {
  return (
    <PrivyStack
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
      loginMethods={['email', 'google']}
      appearance={{ theme: 'light', accentColor: '#2563EB', logo: '/logo.svg' }}
    >
      <PrivyProtectedRoute fallback={<RedirectToLogin />}>
        {children}
      </PrivyProtectedRoute>
    </PrivyStack>
  );
}

// app/login/page.tsx
import { PrivyStack, usePrivy } from '@varity-labs/ui-kit';

function LoginContent() {
  const { authenticated, ready, login } = usePrivy();
  // redirect if authenticated, call login() on button click
}

export default function LoginPage() {
  return (
    <PrivyStack appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}>
      <LoginContent />
    </PrivyStack>
  );
}
\`\`\`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| NEXT_PUBLIC_PRIVY_APP_ID | No (dev auto-config) | Varity Auth credential — managed entirely by Varity. You never need to obtain this manually. |

> **You do not need a Privy account.** \`NEXT_PUBLIC_PRIVY_APP_ID\` is a Varity-managed credential for the authentication service. For development, it is omitted entirely — PrivyStack auto-falls-back to shared Varity dev credentials. For production, \`varitykit app deploy\` injects the correct value automatically. No sign-ups, no dashboards, no manual setup required.

## Known Issues

### Dependency scanner shows unexpected packages in node_modules

Running a dependency scanner on a Varity app may surface packages in \`node_modules\` that appear unrelated to your app. These come from the authentication provider Varity uses internally, which ships as a complete distribution — including optional integrations that Varity does not enable or use.

**What this means for your app:**
- These extra packages are **tree-shaken** — they are never included in your build output (run \`varity_build\` and check the \`out/\` folder: only your app code and email/social auth paths are present).
- They **never execute** in your deployed app — only the email and social login paths are bundled.
- Your app only includes what it uses. The extra entries in \`node_modules\` are unused code paths from a dependency, not features of your app.

**If a security audit or colleague asks:** "Varity uses a managed authentication provider (email, Google, social login). The provider's npm package ships as a complete distribution that includes optional integrations we don't enable. Our build only bundles the email and social login paths — none of the extra packages run in the deployed app."

**Verification:** Run \`varity_build\` and inspect \`out/\` — the build output contains only your app code plus the email and social auth paths.

## Troubleshooting

### Login modal never appears
1. **Check provider mounting** — ensure \`PrivyStack\` wraps your component tree (usually in \`dashboard/layout.tsx\`). If \`usePrivy()\` is called outside a Privy provider, it fails silently.
2. **Check \`ready\` before triggering login** — the modal can only open after \`ready === true\`. Calling \`login()\` before Privy initializes is a no-op. Guard your button:
   \`\`\`tsx
   const { ready, login } = usePrivy();
   <button onClick={login} disabled={!ready}>Sign In</button>
   \`\`\`
3. **Dev credentials expired** — in rare cases, shared dev credentials rotate. Run \`varitykit login\` to refresh them automatically, then re-run \`varitykit doctor\` to confirm connectivity. You do not need to sign up for Privy or obtain any credentials yourself — Varity manages this entirely.

### Auth initializes slowly or times out
- **Expected init time**: 2–8 seconds on a normal connection. \`PrivyReadyGate\` shows a loading screen during this window — this is normal.
- **Timeout screen appears** (after 10 s default): The Varity Auth service hasn't responded. Check:
  - Internet connectivity (Varity's auth servers must be reachable).
  - Ad blockers — some browser extensions block auth API calls. Disable for localhost during development.
  - Corporate firewalls — if your network blocks external auth services, try a different network.
- **Customize the timeout** via \`<PrivyReadyGate timeout={15000}>\` if 10 s is too aggressive for your environment.

### User appears logged out after page refresh
- There is a brief flash where \`authenticated === false\` before the auth service restores the session from its secure cookie. This is expected with \`output: 'export'\` (static sites re-run all client JS on load). This flash is also listed as a known template limitation — see **KNOWN_ISSUES.md** in your project (or \`varity://sdk/patterns\` → KNOWN_ISSUES #3) for the full explanation and why it does not affect production user experience.
- If users are **always** logged out after refresh: your deployment domain may not be registered with Varity Auth. For \`varity.app\` deployments this is configured automatically by \`varitykit app deploy\`. If you deployed manually or to a custom domain, run \`varitykit login\` and then re-deploy via \`varitykit app deploy\` to register the domain automatically.

### Auth works in dev but fails after deploy
- Always deploy via \`varitykit app deploy\` — it injects \`NEXT_PUBLIC_PRIVY_APP_ID\` with production credentials automatically. Manual env var setup is not required.
- If you deployed outside of varitykit, ensure \`NEXT_PUBLIC_PRIVY_APP_ID\` is set in your hosting environment and your Privy app's allowed origins include your production domain.
`;

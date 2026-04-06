export const AUTH_REFERENCE = `
# Varity Auth API Reference (@varity-labs/ui-kit)

All imports from \`@varity-labs/ui-kit\` unless noted. Privy hooks re-exported from \`@privy-io/react-auth\`.

## Provider Hierarchy (Production Pattern)

\`\`\`
QueryClientProvider
  PrivyProvider          ← authentication layer
    PrivyReadyGate       ← prevents blank screen during init
      ThirdwebProvider
        WalletSyncProvider
          YourApp
\`\`\`

PrivyStack wraps all of this into a single component. Use PrivyStack for new apps.

## PrivyStack (Recommended)

All-in-one provider. Wraps Privy + React Query + Thirdweb + WalletSync + PrivyReadyGate.

\`\`\`tsx
import { PrivyStack } from '@varity-labs/ui-kit';

<PrivyStack
  appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}         // optional — falls back to VARITY_DEV_CREDENTIALS
  thirdwebClientId={process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID}  // optional — falls back to VARITY_DEV_CREDENTIALS
  chains={[varityL3Testnet]}          // optional — defaults to Varity L3 (chain 33529)
  loginMethods={['email', 'google', 'wallet']}  // default
  appearance={{
    theme: 'light',           // 'light' | 'dark'
    accentColor: '#2563EB',   // hex string
    logo: '/logo.svg',        // optional logo URL
  }}
  onAddressChange={(addr) => {}}  // called when wallet address changes
>
  <App />
</PrivyStack>
\`\`\`

**Props (PrivyStackProps):**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| appId | string? | VARITY_DEV_CREDENTIALS | Privy app ID |
| thirdwebClientId | string? | VARITY_DEV_CREDENTIALS | Thirdweb client ID |
| chains | Chain[]? | [varityL3Testnet] | Supported chains |
| children | ReactNode | required | App content |
| loginMethods | Array<'email'|'wallet'|'google'|'twitter'|'discord'|'github'|'apple'|'linkedin'|'sms'>? | ['email','google','wallet'] | Login methods |
| appearance | { theme?, accentColor?, logo? }? | { theme:'light', accentColor:'#2563EB' } | UI customization |
| onAddressChange | (address: string|null) => void? | - | Wallet change callback |

**Dev credentials auto-config:** When appId/thirdwebClientId are omitted or empty, PrivyStack uses shared Varity dev credentials automatically via \`resolveCredentials()\` from \`@varity-labs/sdk\`. No .env setup needed for development.

## VarityPrivyProvider (Lower-level)

Wraps Privy + Wagmi + React Query. Does NOT include PrivyReadyGate (you may get a blank screen).

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

Combines Privy + Wagmi + React Query + Thirdweb + WalletSync + PrivyReadyGate + error screens. Requires explicit credentials (no auto-config fallback).

\`\`\`tsx
import { VarityDashboardProvider } from '@varity-labs/ui-kit';

<VarityDashboardProvider
  privyAppId="..."
  thirdwebClientId="..."
  loginMethods={['email', 'google']}
  appearance={{ theme: 'light', accentColor: '#2563EB', logo: '/logo.png' }}
  initTimeout={10000}
  onAddressChange={(addr) => {}}
  onWalletSyncChange={(state) => {}}
  errorBoundary={MyErrorBoundary}
>
  <Dashboard />
</VarityDashboardProvider>
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

Also re-exported: \`useWallets\`, \`useLogin\`, \`useLogout\`.

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

Displays user info: email/social account, wallet address, account type, join date. Returns null when not authenticated.

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
      thirdwebClientId={process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID}
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
| NEXT_PUBLIC_PRIVY_APP_ID | No (dev auto-config) | Privy app ID from dashboard.privy.io |
| NEXT_PUBLIC_THIRDWEB_CLIENT_ID | No (dev auto-config) | Thirdweb client ID from thirdweb.com/dashboard |

For development, both can be omitted — PrivyStack auto-falls-back to shared Varity dev credentials.
For production, set both in \`.env.local\` or pass as props.
`;

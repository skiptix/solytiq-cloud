import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Account switcher session vault ───────────────────────────────────────────
// Holds every account this browser has signed into, so the ProfileCard can
// switch between them without re-entering credentials (see CLAUDE.md's
// "Account Switching").
//
// SECURITY — the three properties that make this safe, all enforced elsewhere
// but stated here because this file is what holds the tokens:
//
//  1. An entry can ONLY be created from a real, successful credential login
//     (password, plus TOTP when the account has 2FA on). There is no server
//     endpoint that mints a token for another user on the strength of the
//     current session — switching re-uses a token the server already issued to
//     that account, it never creates authority.
//  2. A stored token is re-validated server-side (`apiVerifySessionToken`)
//     before it is ever made active, and the SERVER's response is what supplies
//     the identity. Editing this vault in localStorage therefore cannot
//     impersonate anyone: a forged/relabelled entry either fails verification
//     or resolves to whoever the token really belongs to.
//  3. Nothing here weakens the existing revocation path — `users.token_version`
//     still invalidates every outstanding token for a user on password change /
//     forced logout, and the backend re-checks it on every request, so a
//     revoked account drops out of the switcher the next time it's used.
//
// The tokens sit in localStorage alongside the active session's own
// `solytiq_token`, so this introduces no new exposure class: anything that can
// read one can already read the other.

/** How long a stored session stays offerable in the switcher. Mirrors the
 *  backend's `SESSION_TTL` (auth.ts) — an entry older than this is pruned
 *  locally rather than shown as a switch target that is guaranteed to 401. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredAccount {
  userId: string;
  username: string;
  fullName: string;
  email: string;
  profileImage: string | null;
  isAdmin: boolean;
  /** The real, server-issued JWT for this account. */
  token: string;
  /** Epoch ms of the credential login that produced `token`. */
  addedAt: number;
}

// ── Pure helpers (no network / no storage — unit-tested directly) ────────────

export function isSessionFresh(account: StoredAccount, now: number = Date.now()): boolean {
  return now - account.addedAt < SESSION_MAX_AGE_MS;
}

/** Drop entries whose 30-day window has elapsed. */
export function pruneAccounts(accounts: StoredAccount[], now: number = Date.now()): StoredAccount[] {
  return accounts.filter((a) => isSessionFresh(a, now));
}

/** Insert or replace by `userId`, preserving list order for existing entries so
 *  the switcher doesn't reshuffle under the user when a session is refreshed. */
export function upsertAccount(accounts: StoredAccount[], next: StoredAccount): StoredAccount[] {
  const i = accounts.findIndex((a) => a.userId === next.userId);
  if (i === -1) return [...accounts, next];
  const copy = [...accounts];
  copy[i] = next;
  return copy;
}

export function removeAccount(accounts: StoredAccount[], userId: string): StoredAccount[] {
  return accounts.filter((a) => a.userId !== userId);
}

// ── Store ────────────────────────────────────────────────────────────────────

interface AccountsState {
  accounts: StoredAccount[];
  /** Record (or refresh) a signed-in account. Called only after a real login. */
  remember: (account: StoredAccount) => void;
  /** Drop one account from the switcher (sign-out, or a token the server rejected). */
  forget: (userId: string) => void;
  /** Every account still inside its 30-day window, expired ones pruned in place. */
  usable: () => StoredAccount[];
  reset: () => void;
}

const useAccountsStore = create<AccountsState>()(
  persist(
    (set, get) => ({
      accounts: [],

      remember: (account) => {
        set((s) => ({ accounts: pruneAccounts(upsertAccount(s.accounts, account)) }));
      },

      forget: (userId) => {
        set((s) => ({ accounts: removeAccount(s.accounts, userId) }));
      },

      usable: () => {
        const pruned = pruneAccounts(get().accounts);
        // Persist the prune so an expired entry doesn't keep being re-evaluated.
        if (pruned.length !== get().accounts.length) set({ accounts: pruned });
        return pruned;
      },

      reset: () => set({ accounts: [] }),
    }),
    { name: 'solytiq_accounts' }
  )
);

export default useAccountsStore;

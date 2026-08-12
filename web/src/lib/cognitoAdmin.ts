import "server-only";

// Cognito pool operations for the /admin/users roles UI and the live admin
// check (Wave D). Server-only: holds an AWS SDK client and task-role creds;
// never import from client components (and NOT from the worker bundle — the
// dep is web-app only).
//
// Fail-open contract: `liveGroupsFor` returns null on ANY failure (Cognito
// blip, missing env) and logs loud + structured; callers fall back to the
// verified TOKEN groups — a pool outage must never lock admins out. The pool
// mutation/list helpers fail LOUD instead (they back the roles UI, which has
// no token fallback to offer).

import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AdminListGroupsForUserCommandOutput,
  type ListUsersCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Hard client-side deadlines on every Cognito call. The smithy default is 0
 * (= NO timeout), and `liveGroupsFor` sits on the admin page render path — a
 * black-holed request would otherwise hang every admin render instead of
 * failing open to token groups.
 */
export const COGNITO_CONNECTION_TIMEOUT_MS = 2_000;
export const COGNITO_REQUEST_TIMEOUT_MS = 5_000;

/** Live-groups cache TTL: revocation latency ceiling on Admin surfaces. */
export const LIVE_GROUPS_TTL_MS = 60_000;

/** ListUsers page size (Cognito max). */
const LIST_USERS_PAGE_SIZE = 60;

type CognitoCommand =
  | AdminAddUserToGroupCommand
  | AdminListGroupsForUserCommand
  | AdminRemoveUserFromGroupCommand
  | ListUsersCommand;

/** Minimal client surface — lets tests inject a fake without touching AWS. */
export interface CognitoInvoker {
  send(command: CognitoCommand): Promise<unknown>;
}

/** One pool user, shaped for the /admin/users table. `created` is ISO-8601. */
export interface PoolUser {
  username: string;
  email: string;
  status: string;
  created: string | null;
  enabled: boolean;
}

/**
 * Module-level memo: one client per process (task-role credential resolution +
 * TLS session reuse), same rationale as the intel provider cache.
 */
let cachedClient: CognitoInvoker | undefined;

function client(): CognitoInvoker {
  if (!cachedClient) {
    cachedClient = new CognitoIdentityProviderClient({
      // Plain-options form: the SDK builds a NodeHttpHandler from these.
      // Never omit — the default timeouts are 0 (= none); see the constants.
      requestHandler: {
        connectionTimeout: COGNITO_CONNECTION_TIMEOUT_MS,
        requestTimeout: COGNITO_REQUEST_TIMEOUT_MS,
      },
    }) as unknown as CognitoInvoker;
  }
  return cachedClient;
}

/** Pool id for the fail-LOUD pool ops (roles UI); throws when unconfigured. */
function poolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) {
    throw new Error(
      "COGNITO_USER_POOL_ID is not configured: Cognito pool operations are unavailable.",
    );
  }
  return id;
}

/** Every pool user (paginated to exhaustion), mapped for the roles UI. */
export async function listPoolUsers(
  invoker: CognitoInvoker = client(),
): Promise<PoolUser[]> {
  const users: PoolUser[] = [];
  let paginationToken: string | undefined;
  do {
    const page = (await invoker.send(
      new ListUsersCommand({
        UserPoolId: poolId(),
        Limit: LIST_USERS_PAGE_SIZE,
        PaginationToken: paginationToken,
      }),
    )) as ListUsersCommandOutput;
    for (const u of page.Users ?? []) {
      if (!u.Username) continue;
      users.push({
        username: u.Username,
        email: u.Attributes?.find((a) => a.Name === "email")?.Value ?? "",
        status: u.UserStatus ?? "UNKNOWN",
        created: u.UserCreateDate?.toISOString() ?? null,
        enabled: u.Enabled ?? false,
      });
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return users;
}

/** The user's Cognito group names (paginated to exhaustion). */
export async function groupsForUser(
  username: string,
  invoker: CognitoInvoker = client(),
): Promise<string[]> {
  const groups: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = (await invoker.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: poolId(),
        Username: username,
        NextToken: nextToken,
      }),
    )) as AdminListGroupsForUserCommandOutput;
    for (const g of page.Groups ?? []) {
      if (g.GroupName) groups.push(g.GroupName);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return groups;
}

/** Grant: add the user to a Cognito group. Busts the live cache (grants show fast). */
export async function addToGroup(
  username: string,
  group: string,
  invoker: CognitoInvoker = client(),
): Promise<void> {
  await invoker.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: poolId(),
      Username: username,
      GroupName: group,
    }),
  );
  bustLiveGroupsCache();
}

/** Revoke: remove the user from a Cognito group. Busts the live cache (revocation must not wait out the TTL). */
export async function removeFromGroup(
  username: string,
  group: string,
  invoker: CognitoInvoker = client(),
): Promise<void> {
  await invoker.send(
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: poolId(),
      Username: username,
      GroupName: group,
    }),
  );
  bustLiveGroupsCache();
}

interface LiveGroupsEntry {
  groups: string[];
  expiresAt: number;
}

/** In-process cache keyed by lower-cased email. Failures are NEVER cached. */
const liveGroupsCache = new Map<string, LiveGroupsEntry>();

/** Drop one email's cached live groups, or the whole cache when omitted. */
export function bustLiveGroupsCache(email?: string): void {
  if (email === undefined) liveGroupsCache.clear();
  else liveGroupsCache.delete(email.toLowerCase());
}

/**
 * The user's CURRENT pool groups by email — the near-instant-revocation input
 * for `requireAdminUser` (ListUsers email filter → AdminListGroupsForUser,
 * cached {@link LIVE_GROUPS_TTL_MS}).
 *
 * `fresh: true` skips the cache READ (the answer is still cached for the next
 * caller). Admin WRITE paths use it: this app's mutation helpers bust the
 * cache, but an OUT-OF-BAND revocation (AWS console/CLI during incident
 * response) busts nothing — a warm cached admin verdict would let a revoked
 * admin keep granting (even re-grant themselves) for up to the TTL.
 *
 * Returns null (fail-open, logged loud) when the pool is unreachable or
 * COGNITO_USER_POOL_ID is unset (preview/e2e) — callers keep the token
 * verdict. A user ABSENT from the pool is a real answer, not a blip: []
 * (deleted users get revoked, not failed open).
 */
export async function liveGroupsFor(
  email: string,
  invoker: CognitoInvoker = client(),
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string[] | null> {
  const pool = process.env.COGNITO_USER_POOL_ID;
  if (!pool) return null; // preview/e2e profile: token groups stand

  const key = email.toLowerCase();
  const cached = fresh ? undefined : liveGroupsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.groups;

  try {
    // Cognito filter syntax: value in double quotes, inner quotes escaped.
    const filterValue = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const listed = (await invoker.send(
      new ListUsersCommand({
        UserPoolId: pool,
        Filter: `email = "${filterValue}"`,
        Limit: 1,
      }),
    )) as ListUsersCommandOutput;
    const username = listed.Users?.[0]?.Username;
    const groups = username ? await groupsForUser(username, invoker) : [];
    liveGroupsCache.set(key, {
      groups,
      expiresAt: Date.now() + LIVE_GROUPS_TTL_MS,
    });
    return groups;
  } catch (err) {
    // Log loud: this is the difference between "revocation is 60s" and
    // "the live check silently never ran".
    console.warn(
      JSON.stringify({
        msg: "cognito live-groups check failed — falling back to token groups",
        email,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

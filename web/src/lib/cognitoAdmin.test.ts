// @vitest-environment node
// Server-only Cognito pool ops; node env matches the other lib suites. No AWS
// calls: every test injects a FakeCognito through the CognitoInvoker seam
// (the BedrockInvoker pattern from intel/providers.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  addToGroup,
  bustLiveGroupsCache,
  groupsForUser,
  listPoolUsers,
  liveGroupsFor,
  LIVE_GROUPS_TTL_MS,
  removeFromGroup,
  type CognitoInvoker,
} from "./cognitoAdmin";

const POOL = "us-east-1_TESTPOOL";

type AnyCommand =
  | AdminAddUserToGroupCommand
  | AdminListGroupsForUserCommand
  | AdminRemoveUserFromGroupCommand
  | ListUsersCommand;

/** Records every command; delegates responses to the injected handler. */
class FakeCognito implements CognitoInvoker {
  calls: AnyCommand[] = [];
  constructor(private handler: (command: AnyCommand) => unknown = () => ({})) {}
  async send(command: AnyCommand): Promise<unknown> {
    this.calls.push(command);
    return this.handler(command);
  }
  ofType<T extends AnyCommand>(ctor: new (input: never) => T): T[] {
    return this.calls.filter((c): c is T => c instanceof ctor);
  }
}

/** A fake that answers the liveGroupsFor pair: ListUsers → groups-for-user. */
function liveFake(username: string | undefined, groups: string[]): FakeCognito {
  return new FakeCognito((command) => {
    if (command instanceof ListUsersCommand) {
      return { Users: username ? [{ Username: username }] : [] };
    }
    return { Groups: groups.map((g) => ({ GroupName: g })) };
  });
}

beforeEach(() => {
  process.env.COGNITO_USER_POOL_ID = POOL;
  bustLiveGroupsCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.COGNITO_USER_POOL_ID;
  vi.useRealTimers();
});

describe("listPoolUsers", () => {
  it("maps pool users (email attr, status, ISO created, enabled) across pages", async () => {
    const created = new Date("2026-08-01T12:00:00Z");
    const fake = new FakeCognito((command) => {
      const token = (command as ListUsersCommand).input.PaginationToken;
      if (!token) {
        return {
          Users: [
            {
              Username: "u-1",
              Attributes: [
                { Name: "sub", Value: "abc" },
                { Name: "email", Value: "amy@nsightcare.com" },
              ],
              UserStatus: "CONFIRMED",
              UserCreateDate: created,
              Enabled: true,
            },
          ],
          PaginationToken: "page-2",
        };
      }
      return {
        Users: [{ Username: "u-2", Enabled: false }],
      };
    });
    const users = await listPoolUsers(fake);
    expect(users).toEqual([
      {
        username: "u-1",
        email: "amy@nsightcare.com",
        status: "CONFIRMED",
        created: "2026-08-01T12:00:00.000Z",
        enabled: true,
      },
      {
        username: "u-2",
        email: "",
        status: "UNKNOWN",
        created: null,
        enabled: false,
      },
    ]);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(2);
    expect(fake.ofType(ListUsersCommand)[1]?.input.PaginationToken).toBe("page-2");
  });

  it("throws (fail LOUD) when COGNITO_USER_POOL_ID is unset", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    await expect(listPoolUsers(new FakeCognito())).rejects.toThrow(
      /COGNITO_USER_POOL_ID/,
    );
  });
});

describe("groupsForUser", () => {
  it("collects group names across NextToken pages", async () => {
    const fake = new FakeCognito((command) => {
      const token = (command as AdminListGroupsForUserCommand).input.NextToken;
      if (!token) {
        return { Groups: [{ GroupName: "marketing" }], NextToken: "more" };
      }
      return { Groups: [{ GroupName: "marketinghub-admins" }] };
    });
    expect(await groupsForUser("u-1", fake)).toEqual([
      "marketing",
      "marketinghub-admins",
    ]);
    const sent = fake.ofType(AdminListGroupsForUserCommand);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({ UserPoolId: POOL, Username: "u-1" });
  });
});

describe("addToGroup / removeFromGroup", () => {
  it("sends the admin add/remove commands with pool, username, and group", async () => {
    const fake = new FakeCognito();
    await addToGroup("u-1", "mh-section-intel", fake);
    await removeFromGroup("u-1", "mh-section-platform", fake);
    expect(fake.ofType(AdminAddUserToGroupCommand)[0]?.input).toEqual({
      UserPoolId: POOL,
      Username: "u-1",
      GroupName: "mh-section-intel",
    });
    expect(fake.ofType(AdminRemoveUserFromGroupCommand)[0]?.input).toEqual({
      UserPoolId: POOL,
      Username: "u-1",
      GroupName: "mh-section-platform",
    });
  });

  it("busts the live-groups cache so a revoke lands before the TTL", async () => {
    const fake = liveFake("u-1", ["marketinghub-admins"]);
    await liveGroupsFor("amy@nsightcare.com", fake); // primes the cache
    await removeFromGroup("u-1", "marketinghub-admins", fake);
    await liveGroupsFor("amy@nsightcare.com", fake); // must re-hit the pool
    expect(fake.ofType(ListUsersCommand)).toHaveLength(2);
  });
});

describe("liveGroupsFor", () => {
  it("resolves email → username → groups, filtering by the exact email", async () => {
    const fake = liveFake("u-1", ["marketing", "marketinghub-admins"]);
    expect(await liveGroupsFor("amy@nsightcare.com", fake)).toEqual([
      "marketing",
      "marketinghub-admins",
    ]);
    expect(fake.ofType(ListUsersCommand)[0]?.input.Filter).toBe(
      'email = "amy@nsightcare.com"',
    );
  });

  it("serves from the 60s cache, then refetches after the TTL lapses", async () => {
    vi.useFakeTimers();
    const fake = liveFake("u-1", ["marketing"]);
    await liveGroupsFor("amy@nsightcare.com", fake);
    await liveGroupsFor("amy@nsightcare.com", fake);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(1); // cached
    vi.advanceTimersByTime(LIVE_GROUPS_TTL_MS + 1);
    await liveGroupsFor("amy@nsightcare.com", fake);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(2); // expired
  });

  it("fresh: true skips the cache READ (out-of-band revocation cannot ride a warm entry)", async () => {
    const fake = liveFake("u-1", ["marketinghub-admins"]);
    await liveGroupsFor("amy@nsightcare.com", fake); // warm, well within TTL
    await liveGroupsFor("amy@nsightcare.com", fake, { fresh: true });
    expect(fake.ofType(ListUsersCommand)).toHaveLength(2); // re-hit the pool
  });

  it("fresh: true still caches its answer for the next plain caller", async () => {
    const fake = liveFake("u-1", ["marketing"]);
    await liveGroupsFor("amy@nsightcare.com", fake, { fresh: true });
    await liveGroupsFor("amy@nsightcare.com", fake);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(1); // second call cached
  });

  it("caches case-insensitively by email", async () => {
    const fake = liveFake("u-1", ["marketing"]);
    await liveGroupsFor("Amy@NsightCare.com", fake);
    await liveGroupsFor("amy@nsightcare.com", fake);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(1);
  });

  it("bustLiveGroupsCache(email) forces the next call back to the pool", async () => {
    const fake = liveFake("u-1", ["marketing"]);
    await liveGroupsFor("amy@nsightcare.com", fake);
    bustLiveGroupsCache("Amy@nsightcare.com"); // any casing
    await liveGroupsFor("amy@nsightcare.com", fake);
    expect(fake.ofType(ListUsersCommand)).toHaveLength(2);
  });

  it("returns [] (a REAL revoke, not a blip) when the email is not in the pool", async () => {
    expect(await liveGroupsFor("gone@nsightcare.com", liveFake(undefined, []))).toEqual([]);
  });

  it("returns null quietly when COGNITO_USER_POOL_ID is unset (preview/e2e)", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeCognito();
    expect(await liveGroupsFor("amy@nsightcare.com", fake)).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails OPEN (null + loud structured log) when the pool call throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeCognito(() => {
      throw new Error("TooManyRequestsException");
    });
    expect(await liveGroupsFor("amy@nsightcare.com", fake)).toBeNull();
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      msg: "cognito live-groups check failed — falling back to token groups",
      email: "amy@nsightcare.com",
      error: "TooManyRequestsException",
    });
  });

  it("never caches a failure — the next call retries the pool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const fake = new FakeCognito((command) => {
      if (fail) throw new Error("blip");
      if (command instanceof ListUsersCommand) {
        return { Users: [{ Username: "u-1" }] };
      }
      return { Groups: [{ GroupName: "marketing" }] };
    });
    expect(await liveGroupsFor("amy@nsightcare.com", fake)).toBeNull();
    fail = false;
    expect(await liveGroupsFor("amy@nsightcare.com", fake)).toEqual(["marketing"]);
  });

  it("escapes quotes/backslashes in the email before building the filter", async () => {
    const fake = liveFake(undefined, []);
    await liveGroupsFor('evil"@x.com', fake);
    expect(fake.ofType(ListUsersCommand)[0]?.input.Filter).toBe(
      'email = "evil\\"@x.com"',
    );
  });
});

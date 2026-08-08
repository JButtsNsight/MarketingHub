"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";
import { DataTable, type Column } from "../ui/DataTable";
import { Surface } from "../Surface";
import type { GoTrueUser } from "@/lib/console/gotrue";

/**
 * GoTrue Users table (Studio → Authentication → Users parity, Wave 3-partial).
 * READ-ONLY BY DESIGN — the wave's hard constraint: every control here only
 * reshapes the query the group-gated /api/console/gotrue/users route runs
 * (page, server-side substring filter, created_at direction). There is no
 * invite/ban/delete/edit affordance anywhere on this surface, deliberately.
 *
 * The list endpoint is not eager-loaded (identities is null and factors is
 * absent on every row), so expanding a row fetches the single-user detail
 * route for identities, MFA factors, and metadata.
 *
 * Honest states, never faked:
 *   - 503 + `unavailable` → "GoTrue unreachable" (GoTrue down ≠ empty store).
 *   - zero users with no filter → "No GoTrue users" + WHY (app identity is
 *     Cognito/SAML today; the store activates at the pending Wave-3 cutover).
 */

/** Fixed page size — matches the route/lib default and X-Total-Count paging. */
const PER_PAGE = 50;

type SortDir = "asc" | "desc";

interface Filters {
  page: number;
  filter: string;
  sort: SortDir;
}

interface DetailState {
  loading: boolean;
  error: string | null;
  user: GoTrueUser | null;
}

/** Row status → house tone. Banned IS a failure state → --fail. */
function statusOf(user: GoTrueUser): { label: string; tone?: string } {
  if (
    typeof user.banned_until === "string" &&
    Date.parse(user.banned_until) > Date.now()
  ) {
    return { label: "banned", tone: "var(--fail)" };
  }
  if (user.email_confirmed_at) {
    return { label: "confirmed", tone: "var(--data-4)" };
  }
  return { label: "unconfirmed" };
}

/** Primary identity cell: email, else phone, else the anonymous marker. */
function identityOf(user: GoTrueUser): string {
  if (user.email) return user.email;
  if (user.phone) return user.phone;
  return user.is_anonymous ? "anonymous" : "—";
}

function metadataJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/** The eager-loaded detail block an expanded row reveals. */
function UserDetail({ detail }: { detail: DetailState }) {
  if (detail.loading) {
    return <p className="dim">Loading user detail…</p>;
  }
  if (detail.error) {
    return (
      <p className="form-error" role="alert">
        {detail.error}
      </p>
    );
  }
  const user = detail.user;
  if (!user) return null;

  const identities = user.identities ?? [];
  const factors = user.factors ?? [];

  return (
    <div className="stack" style={{ marginTop: "0.75rem" }}>
      <div>
        <span className="eyebrow">Identities</span>
        {identities.length === 0 ? (
          <p className="dim">No linked identities.</p>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>provider</th>
                <th>provider id</th>
                <th>created</th>
              </tr>
            </thead>
            <tbody>
              {identities.map((identity) => (
                <tr key={identity.identity_id}>
                  <td>
                    <Badge>{identity.provider}</Badge>
                  </td>
                  <td className="mono">{identity.id}</td>
                  <td className="mono">{identity.created_at || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <span className="eyebrow">MFA factors ({factors.length})</span>
        {factors.length === 0 ? (
          <p className="dim">No MFA factors enrolled.</p>
        ) : (
          <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
            {factors.map((factor) => (
              <li key={factor.id}>
                <Badge>{factor.factor_type}</Badge>{" "}
                <Badge
                  tone={
                    factor.status === "verified" ? "var(--data-4)" : undefined
                  }
                >
                  {factor.status}
                </Badge>{" "}
                {factor.friendly_name ? (
                  <span>{factor.friendly_name}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <CodeBlock label="app_metadata" code={metadataJson(user.app_metadata)} />
      <CodeBlock
        label="user_metadata"
        code={metadataJson(user.user_metadata)}
      />
    </div>
  );
}

export function AuthUsersClient() {
  const [users, setUsers] = useState<GoTrueUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState<Record<string, DetailState>>({});

  const runQuery = async (filters: Filters) => {
    setLoading(true);
    setError(null);
    // Cleared alongside error: a stale `unavailable` from an earlier outage
    // must never co-render with a later REAL answer (error alert or table) —
    // "GoTrue did not answer" and "GoTrue answered" cannot both be true.
    setUnavailable(false);
    try {
      const params = new URLSearchParams({
        page: String(filters.page),
        per_page: String(PER_PAGE),
        sort: filters.sort,
      });
      const trimmed = filters.filter.trim();
      if (trimmed !== "") params.set("filter", trimmed);

      const res = await fetch(`/api/console/gotrue/users?${params.toString()}`);
      const body = (await res.json().catch(() => null)) as {
        users?: GoTrueUser[];
        total?: number;
        error?: string;
        unavailable?: boolean;
      } | null;

      if (res.status === 503 && body?.unavailable) {
        // Honest outage state — GoTrue being down is never an empty store.
        setUnavailable(true);
        setUsers([]);
        setTotal(0);
        setExpanded(new Set());
        setDetails({});
        return;
      }
      if (!res.ok || !body || !Array.isArray(body.users)) {
        setError(body?.error ?? "User query failed.");
        return;
      }
      const nextTotal =
        typeof body.total === "number" ? body.total : body.users.length;
      const lastPage = Math.max(1, Math.ceil(nextTotal / PER_PAGE));
      if (filters.page > lastPage) {
        // The store shrank under us (rows deleted upstream since the last
        // query), so the requested page no longer exists. Land on the last
        // real page instead of captioning an impossible "Page N of M", N > M.
        await runQuery({ ...filters, page: lastPage });
        return;
      }
      setUsers(body.users);
      setTotal(nextTotal);
      setPage(filters.page);
      setAppliedFilter(trimmed);
      // A fresh answer invalidates the per-user detail cache too — Refresh
      // must refetch identities/factors/metadata, not replay pre-refresh PII.
      setExpanded(new Set());
      setDetails({});
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  useEffect(() => {
    void runQuery({ page: 1, filter: "", sort: "desc" });
    // Mount-only initial load; later loads go through the controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDetail = async (id: string) => {
    setDetails((prev) => ({
      ...prev,
      [id]: { loading: true, error: null, user: null },
    }));
    try {
      const res = await fetch(
        `/api/console/gotrue/users/${encodeURIComponent(id)}`,
      );
      const body = (await res.json().catch(() => null)) as {
        user?: GoTrueUser;
        error?: string;
      } | null;
      if (!res.ok || !body || !body.user) {
        setDetails((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            error: body?.error ?? "Could not load user detail.",
            user: null,
          },
        }));
        return;
      }
      setDetails((prev) => ({
        ...prev,
        [id]: { loading: false, error: null, user: body.user ?? null },
      }));
    } catch {
      setDetails((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          error: "Network error — please try again.",
          user: null,
        },
      }));
    }
  };

  const toggleExpanded = (id: string) => {
    const isOpen = expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Fetch the eager detail on first open (cached afterwards) — the list
    // rows deliberately carry no identities/factors. A cached FAILURE never
    // sticks: re-expanding after an error retries, so the inline "please
    // try again" copy is actually honorable without a full page reload.
    if (!isOpen && (!details[id] || details[id].error)) void loadDetail(id);
  };

  const submitFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runQuery({ page: 1, filter, sort });
  };

  const toggleSort = () => {
    const next: SortDir = sort === "desc" ? "asc" : "desc";
    setSort(next);
    void runQuery({ page: 1, filter: appliedFilter, sort: next });
  };

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  const changePage = (next: number) => {
    if (next < 1 || next > pageCount || next === page) return;
    void runQuery({ page: next, filter: appliedFilter, sort });
  };

  const columns: Column<GoTrueUser>[] = [
    {
      key: "expand",
      header: "",
      width: "44px",
      render: (row) => {
        const isOpen = expanded.has(row.id);
        return (
          <button
            type="button"
            className="type-chip"
            aria-expanded={isOpen}
            aria-label={isOpen ? "Collapse user detail" : "Expand user detail"}
            onClick={() => toggleExpanded(row.id)}
          >
            {isOpen ? "−" : "+"}
          </button>
        );
      },
    },
    {
      key: "identity",
      header: "user",
      render: (row) => {
        const isOpen = expanded.has(row.id);
        return (
          <div>
            <span>{identityOf(row)}</span>{" "}
            <span className="mono dim" title={row.id}>
              {row.id.slice(0, 8)}…
            </span>
            {isOpen ? (
              <UserDetail
                detail={
                  details[row.id] ?? { loading: true, error: null, user: null }
                }
              />
            ) : null}
          </div>
        );
      },
    },
    {
      key: "created_at",
      header: "created",
      mono: true,
      width: "190px",
      render: (row) => row.created_at || "—",
    },
    {
      key: "last_sign_in_at",
      header: "last sign-in",
      mono: true,
      width: "190px",
      render: (row) => row.last_sign_in_at ?? "never",
    },
    {
      key: "status",
      header: "status",
      width: "130px",
      render: (row) => {
        const status = statusOf(row);
        return <Badge tone={status.tone}>{status.label}</Badge>;
      },
    },
  ];

  return (
    <div className="stack">
      <form className="dgrid-toolbar" role="search" onSubmit={submitFilter}>
        <input
          className="surface control teditor-fctl"
          type="search"
          aria-label="Filter by email or full name"
          placeholder="Filter by email or full name"
          maxLength={200}
          value={filter}
          disabled={loading}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button type="submit" className="type-chip" disabled={loading}>
          Search
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="type-chip"
          title="Toggle created_at sort direction (the only sortable field)"
          disabled={loading}
          onClick={toggleSort}
        >
          {sort === "desc" ? "Newest first" : "Oldest first"}
        </button>
        <button
          type="button"
          className="type-chip"
          disabled={loading}
          onClick={() => void runQuery({ page, filter: appliedFilter, sort })}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </form>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {unavailable ? (
        <Surface className="empty-state" glint>
          <h2>GoTrue unreachable</h2>
          <p>
            The GoTrue auth service did not answer through the data API. This
            view reads live from GoTrue, so there is nothing to show until it
            answers again. Nothing else in the console is affected.
          </p>
        </Surface>
      ) : loaded && !loading && total === 0 && appliedFilter === "" && !error ? (
        <Surface className="empty-state" glint>
          <h2>No GoTrue users</h2>
          <p>
            Empty by design today: app identity is Cognito federated to the
            Nsight Google Workspace SAML app, so nobody signs in through
            GoTrue yet. This store activates at the Wave-3 SAML cutover — an
            external deliverable that is still pending.
          </p>
        </Surface>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={users}
            getRowKey={(row) => row.id}
            empty={
              loading
                ? "Loading…"
                : appliedFilter !== ""
                  ? "No users match this filter."
                  : "No users on this page."
            }
          />
          <div
            className="dgrid-toolbar"
            role="navigation"
            aria-label="User pages"
          >
            <button
              type="button"
              className="type-chip"
              disabled={loading || page <= 1}
              onClick={() => changePage(page - 1)}
            >
              Previous
            </button>
            <span className="count mono">
              Page {page} of {pageCount} — {total}{" "}
              {total === 1 ? "user" : "users"}
            </span>
            <button
              type="button"
              className="type-chip"
              disabled={loading || page >= pageCount}
              onClick={() => changePage(page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default AuthUsersClient;

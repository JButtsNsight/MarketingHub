"use client";

import { useEffect, useState } from "react";

import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Surface } from "../Surface";
import {
  ADMIN_GROUP,
  ALL_ASSIGNABLE_GROUPS,
  MARKETING_GROUP,
  SECTIONS,
} from "@/lib/authGroups";
import type { RoleUser } from "@/app/api/console/cognito/users/route";

/**
 * Users & Roles (Wave D): the Cognito pool users table with per-user group
 * toggle chips — marketing / platform / intel / god-mode, straight from the
 * fixed registry in authGroups. Toggles apply OPTIMISTICALLY and revert on a
 * failed POST; the server owns the real guards (registry check, live admin
 * gate, own-god-mode lockout) — the disabled own-god-mode chip here is UX,
 * not enforcement. Groups outside the registry render as plain badges
 * (visible, untogglable — this UI never mutates what the code doesn't know).
 *
 * Honest states: a 503 `unavailable` answer renders "Cognito unreachable"
 * (pool down ≠ empty pool).
 */

/** The four toggleable groups, in rank order. Labels stay chip-terse. */
const TOGGLES: { group: string; label: string }[] = [
  { group: MARKETING_GROUP, label: "marketing" },
  ...SECTIONS.map((s) => ({ group: s.group, label: s.id })),
  { group: ADMIN_GROUP, label: "god-mode" },
];

/** Row status → house tone. Disabled IS a failure state → --fail. */
function statusOf(user: RoleUser): { label: string; tone?: string } {
  if (!user.enabled) return { label: "disabled", tone: "var(--fail)" };
  if (user.status === "CONFIRMED") {
    return { label: "confirmed", tone: "var(--data-4)" };
  }
  return { label: user.status.toLowerCase().replace(/_/g, " ") };
}

export function UsersRoles({ currentEmail }: { currentEmail: string }) {
  const [users, setUsers] = useState<RoleUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const res = await fetch("/api/console/cognito/users");
      const body = (await res.json().catch(() => null)) as {
        users?: RoleUser[];
        error?: string;
        unavailable?: boolean;
      } | null;
      if (res.status === 503 && body?.unavailable) {
        setUnavailable(true);
        setUsers([]);
        return;
      }
      if (!res.ok || !body || !Array.isArray(body.users)) {
        setError(body?.error ?? "User query failed.");
        return;
      }
      setUsers(body.users);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // Mount-only initial load; later loads go through Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Flip one membership in local state (the optimistic apply AND the revert). */
  const applyLocal = (username: string, group: string, action: "add" | "remove") =>
    setUsers((prev) =>
      prev.map((u) => {
        if (u.username !== username) return u;
        const groups =
          action === "add"
            ? u.groups.includes(group)
              ? u.groups
              : [...u.groups, group]
            : u.groups.filter((g) => g !== group);
        return { ...u, groups };
      }),
    );

  const toggle = async (row: RoleUser, group: string, member: boolean) => {
    const action: "add" | "remove" = member ? "remove" : "add";
    const key = `${row.username}:${group}`;
    setPending((prev) => new Set(prev).add(key));
    setSaveError(null);
    applyLocal(row.username, group, action); // optimistic
    try {
      const res = await fetch("/api/console/cognito/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: row.username, group, action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        applyLocal(row.username, group, member ? "add" : "remove"); // revert
        setSaveError(body?.error ?? "Change failed.");
      }
    } catch {
      applyLocal(row.username, group, member ? "add" : "remove"); // revert
      setSaveError("Network error — please try again.");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const columns: Column<RoleUser>[] = [
    {
      key: "email",
      header: "user",
      render: (row) =>
        row.email ? (
          <span title={row.username}>{row.email}</span>
        ) : (
          <span className="mono dim">{row.username}</span>
        ),
    },
    {
      key: "status",
      header: "status",
      width: "150px",
      render: (row) => {
        const status = statusOf(row);
        return <Badge tone={status.tone}>{status.label}</Badge>;
      },
    },
    {
      key: "created",
      header: "created",
      mono: true,
      width: "190px",
      render: (row) => row.created ?? "—",
    },
    {
      key: "access",
      header: "access",
      render: (row) => {
        const self = row.email.toLowerCase() === currentEmail.toLowerCase();
        const extras = row.groups.filter(
          (g) => !ALL_ASSIGNABLE_GROUPS.includes(g),
        );
        return (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
              alignItems: "center",
            }}
          >
            {TOGGLES.map(({ group, label }) => {
              const member = row.groups.includes(group);
              // Own-god-mode UX (server-enforced too): no self-demotion
              // (lockout) and no self-grant (escalation guard).
              const locked = self && group === ADMIN_GROUP;
              return (
                <button
                  key={group}
                  type="button"
                  className={member ? "type-chip on" : "type-chip"}
                  aria-pressed={member}
                  disabled={locked || pending.has(`${row.username}:${group}`)}
                  title={
                    locked
                      ? `You can't ${member ? "remove" : "grant"} your own god-mode.`
                      : group
                  }
                  onClick={() => void toggle(row, group, member)}
                >
                  {label}
                </button>
              );
            })}
            {extras.map((g) => (
              <Badge key={g}>{g}</Badge>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack">
      <div className="dgrid-toolbar">
        <span className="count mono">
          {users.length} {users.length === 1 ? "user" : "users"}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="type-chip"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      {unavailable ? (
        <Surface className="empty-state" glint>
          <h2>Cognito unreachable</h2>
          <p>The user pool did not answer — roles can’t be read or changed.</p>
        </Surface>
      ) : (
        <DataTable
          columns={columns}
          rows={users}
          getRowKey={(row) => row.username}
          empty={loading || !loaded ? "Loading…" : "No pool users."}
        />
      )}
    </div>
  );
}

export default UsersRoles;

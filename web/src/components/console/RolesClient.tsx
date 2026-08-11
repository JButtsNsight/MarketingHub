"use client";

import { useState, type CSSProperties } from "react";

import { DataTable, type Column } from "../ui/DataTable";
import { StatCard } from "../ui/StatCard";
import { Section } from "../ui/Section";
import { Badge } from "../ui/Badge";
import { Surface } from "../Surface";
import { useConfirm } from "../ui/AlertDialog";

/**
 * Database → Roles client island (Studio Database → Roles). Browsing the role
 * catalog and its memberships (pg_auth_members) is a plain read — no confirm.
 * The three writes — create, alter, and drop role — are DDL run as the database
 * superuser, so each goes behind the interrupting confirm modal (useConfirm),
 * matching the controls-match-risk rule: guard the write, not the browse.
 *
 * Every action addresses the role by its structured name + typed attributes;
 * the /api/console/roles route re-validates the identifier against the
 * allow-list, quotes it, and passes values as literals before any statement is
 * built. Platform-critical roles (service_role, supabase_*, pg_*, …) are shown
 * but their alter/drop controls are disabled here, and the route refuses them
 * regardless — this UI gate is only an affordance.
 */

/** Mirrors PgRole from the server lib (kept local so this client owns its DTO). */
export interface RoleRow {
  name: string;
  isSuperuser: boolean;
  canLogin: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  isReplication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
  validUntil: string | null;
}

export interface RoleMembership {
  /** The group role (roleid). */
  role: string;
  /** The member role granted into the group. */
  member: string;
  adminOption: boolean;
  grantor: string | null;
}

/** The six boolean role attributes the form toggles. */
type FlagKey =
  | "canLogin"
  | "isSuperuser"
  | "canCreateRole"
  | "canCreateDb"
  | "isReplication"
  | "bypassRls";

/** The mutable attributes a create/alter form collects. */
interface RoleAttrs {
  canLogin: boolean;
  isSuperuser: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  isReplication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
  validUntil: string | null;
  password?: string;
}

/**
 * Platform-critical roles whose alter/drop is disabled in the UI. The server
 * enforces the same refusal — this list only drives the disabled state so the
 * operator isn't offered a control that will 400.
 */
const RESERVED_ROLES = new Set([
  "postgres",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "supabase_read_only_user",
  "supabase_replication_admin",
  "authenticator",
  "anon",
  "authenticated",
  "service_role",
  "dashboard_user",
  "pgbouncer",
]);

function isProtected(name: string): boolean {
  return RESERVED_ROLES.has(name) || /^pg_/i.test(name);
}

/** A Postgres unquoted identifier — mirrors the server allow-list for fast UX. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CREATE_BUSY = "__create__";

const badgeRow: CSSProperties = { display: "flex", gap: "4px", flexWrap: "wrap" };
const rightToolbar: CSSProperties = { justifyContent: "flex-end", padding: 0 };

export function RolesClient({
  initialRoles,
  initialMemberships,
}: {
  initialRoles: RoleRow[];
  initialMemberships: RoleMembership[];
}) {
  const [roles, setRoles] = useState(initialRoles);
  const [memberships, setMemberships] = useState(initialMemberships);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [alterName, setAlterName] = useState<string | null>(null);

  // Modal confirmation before any DDL (create / alter / drop).
  const { confirm, dialog } = useConfirm();

  const refresh = async () => {
    try {
      const res = await fetch("/api/console/roles");
      if (!res.ok) return;
      const body = (await res.json()) as {
        roles?: RoleRow[];
        memberships?: RoleMembership[];
      };
      setRoles(body.roles ?? []);
      setMemberships(body.memberships ?? []);
    } catch {
      // best-effort re-read; the action's own error surface covers failures
    }
  };

  const send = async (
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>,
    busyKey: string,
    failMsg: string,
  ): Promise<boolean> => {
    setError(null);
    setBusy(busyKey);
    try {
      const res = await fetch("/api/console/roles", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(b?.error ?? failMsg);
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError("Network error — please try again.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const submitCreate = async (name: string, attrs: RoleAttrs) => {
    const ok = await confirm({
      title: `Create role ${name}?`,
      message:
        "This runs CREATE ROLE as the database superuser, adding a new login/role " +
        "with the attributes you selected. Continue?",
      confirmLabel: "Create role",
    });
    if (!ok) return;
    const done = await send("POST", { name, ...attrs }, CREATE_BUSY, "Creating the role failed.");
    if (done) setCreateOpen(false);
  };

  const submitAlter = async (name: string, attrs: RoleAttrs) => {
    const ok = await confirm({
      title: `Alter role ${name}?`,
      message:
        `This runs ALTER ROLE as the database superuser and changes ${name}'s ` +
        "privileges/attributes immediately. Continue?",
      confirmLabel: "Alter role",
    });
    if (!ok) return;
    const done = await send("PATCH", { name, ...attrs }, name, "Altering the role failed.");
    if (done) setAlterName(null);
  };

  const dropRole = async (role: RoleRow) => {
    const ok = await confirm({
      title: `Drop role ${role.name}?`,
      message:
        `Permanently drop role ${role.name}. This runs DROP ROLE and cannot be undone; ` +
        "it fails if the role still owns objects or holds grants. Continue?",
      confirmLabel: "Drop role",
    });
    if (!ok) return;
    await send("DELETE", { name: role.name }, role.name, "Dropping the role failed.");
  };

  const loginCount = roles.filter((r) => r.canLogin).length;
  const superuserCount = roles.filter((r) => r.isSuperuser).length;

  const roleColumns: Column<RoleRow>[] = [
    { key: "name", header: "role", mono: true },
    {
      key: "attributes",
      header: "attributes",
      render: (r) => {
        const flags = [
          r.isSuperuser ? <Badge key="su" tone="var(--warn)">superuser</Badge> : null,
          r.canLogin ? <Badge key="lg" tone="var(--ok)">login</Badge> : null,
          r.canCreateRole ? <Badge key="cr">createrole</Badge> : null,
          r.canCreateDb ? <Badge key="cd">createdb</Badge> : null,
          r.isReplication ? <Badge key="rp">replication</Badge> : null,
          r.bypassRls ? <Badge key="br" tone="var(--warn)">bypassrls</Badge> : null,
        ].filter(Boolean);
        return flags.length > 0 ? (
          <span style={badgeRow}>{flags}</span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
    {
      key: "connectionLimit",
      header: "conn limit",
      mono: true,
      width: "100px",
      render: (r) => (r.connectionLimit < 0 ? "∞" : String(r.connectionLimit)),
    },
    {
      key: "validUntil",
      header: "valid until",
      mono: true,
      width: "180px",
      render: (r) => (r.validUntil ? r.validUntil : "—"),
    },
    {
      key: "actions",
      header: "",
      width: "170px",
      align: "right",
      render: (r) => {
        if (isProtected(r.name)) {
          return (
            <span className="muted" title="Platform-critical role — manage via migration/SQL editor">
              protected
            </span>
          );
        }
        const rowBusy = busy === r.name;
        return (
          <span className="dgrid-toolbar" style={rightToolbar}>
            <button
              type="button"
              className="type-chip"
              disabled={rowBusy}
              onClick={() => {
                setCreateOpen(false);
                setAlterName((cur) => (cur === r.name ? null : r.name));
              }}
            >
              {alterName === r.name ? "Close" : "Alter"}
            </button>
            <button
              type="button"
              className="type-chip"
              disabled={rowBusy}
              onClick={() => void dropRole(r)}
            >
              Drop
            </button>
          </span>
        );
      },
    },
  ];

  const membershipColumns: Column<RoleMembership>[] = [
    { key: "role", header: "role (group)", mono: true },
    { key: "member", header: "member", mono: true },
    {
      key: "adminOption",
      header: "admin option",
      width: "130px",
      render: (m) =>
        m.adminOption ? <Badge tone="var(--ok)">yes</Badge> : <Badge>no</Badge>,
    },
    {
      key: "grantor",
      header: "grantor",
      mono: true,
      width: "180px",
      render: (m) => m.grantor ?? "—",
    },
  ];

  const alterRole = alterName ? roles.find((r) => r.name === alterName) ?? null : null;

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Roles" value={roles.length} accent="var(--data-2)" />
        <StatCard label="Can login" value={loginCount} accent="var(--data-3)" />
        <StatCard label="Superusers" value={superuserCount} />
        <StatCard label="Memberships" value={memberships.length} accent="var(--data-4)" />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="Roles"
        title="Database roles"
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setAlterName(null);
              setCreateOpen((v) => !v);
            }}
          >
            {createOpen ? "Close" : "Create role"}
          </button>
        }
      >
        {createOpen ? (
          <RoleForm
            key="create"
            mode="create"
            busy={busy === CREATE_BUSY}
            onCancel={() => setCreateOpen(false)}
            onSubmit={submitCreate}
          />
        ) : null}
        {alterRole ? (
          <RoleForm
            key={`alter-${alterRole.name}`}
            mode="alter"
            initial={alterRole}
            busy={busy === alterRole.name}
            onCancel={() => setAlterName(null)}
            onSubmit={submitAlter}
          />
        ) : null}
        <DataTable
          columns={roleColumns}
          rows={roles}
          getRowKey={(r) => r.name}
          empty="No roles."
          paginate={50}
        />
      </Section>

      <Section
        eyebrow="Memberships"
        title="Role memberships"
        actions={
          <button type="button" className="type-chip" onClick={() => void refresh()}>
            Refresh
          </button>
        }
      >
        <DataTable
          columns={membershipColumns}
          rows={memberships}
          getRowKey={(m, i) => `${m.role}->${m.member}-${i}`}
          empty="No role memberships (pg_auth_members is empty)."
          paginate={50}
        />
      </Section>

      {dialog}
    </div>
  );
}

const BOOLEAN_ATTRS: Array<{ key: FlagKey; label: string }> = [
  { key: "canLogin", label: "Can login" },
  { key: "isSuperuser", label: "Superuser" },
  { key: "canCreateRole", label: "Create roles" },
  { key: "canCreateDb", label: "Create databases" },
  { key: "isReplication", label: "Replication" },
  { key: "bypassRls", label: "Bypass RLS" },
];

/**
 * Create/alter form. In alter mode the name is fixed (rename is a distinct
 * operation) and the fields are pre-filled from the role's current attributes;
 * a blank password means "leave unchanged". Submission is handed up to the
 * parent, which fires the confirm modal before touching the route.
 */
function RoleForm({
  mode,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "alter";
  initial?: RoleRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, attrs: RoleAttrs) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [flags, setFlags] = useState<Record<FlagKey, boolean>>({
    canLogin: initial?.canLogin ?? false,
    isSuperuser: initial?.isSuperuser ?? false,
    canCreateRole: initial?.canCreateRole ?? false,
    canCreateDb: initial?.canCreateDb ?? false,
    isReplication: initial?.isReplication ?? false,
    bypassRls: initial?.bypassRls ?? false,
  });
  const [connLimit, setConnLimit] = useState(String(initial?.connectionLimit ?? -1));
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? "");
  const [password, setPassword] = useState("");

  const nameValid = mode === "alter" || IDENTIFIER_RE.test(name.trim());

  const submit = () => {
    const parsedLimit = Number.parseInt(connLimit, 10);
    const attrs: RoleAttrs = {
      ...flags,
      connectionLimit: Number.isFinite(parsedLimit) ? parsedLimit : -1,
      validUntil: validUntil.trim() === "" ? null : validUntil.trim(),
      ...(password ? { password } : {}),
    };
    onSubmit(name.trim(), attrs);
  };

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">
        {mode === "create" ? "Create role" : `Alter role ${initial?.name}`}
      </span>
      <div className="teditor-insert-grid">
        {mode === "create" ? (
          <div className="field">
            <label htmlFor="role-name">name</label>
            <input
              id="role-name"
              className="surface control mono"
              type="text"
              placeholder="new_role"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : null}

        {BOOLEAN_ATTRS.map((attr) => (
          <div className="field" key={attr.key}>
            <label htmlFor={`role-${attr.key}`}>{attr.label}</label>
            <label className="teditor-null">
              <input
                id={`role-${attr.key}`}
                type="checkbox"
                checked={flags[attr.key]}
                onChange={(e) =>
                  setFlags((f) => ({ ...f, [attr.key]: e.target.checked }))
                }
              />{" "}
              {flags[attr.key] ? "yes" : "no"}
            </label>
          </div>
        ))}

        <div className="field">
          <label htmlFor="role-connlimit">
            connection limit
            <span className="teditor-test mono"> -1 = unlimited</span>
          </label>
          <input
            id="role-connlimit"
            className="surface control mono"
            type="number"
            min={-1}
            value={connLimit}
            onChange={(e) => setConnLimit(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="role-validuntil">
            valid until
            <span className="teditor-test mono"> timestamp; blank = no expiry</span>
          </label>
          <input
            id="role-validuntil"
            className="surface control mono"
            type="text"
            placeholder="2027-01-01 00:00:00+00"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="role-password">
            password
            <span className="teditor-test mono">
              {mode === "alter" ? " blank = unchanged" : " optional"}
            </span>
          </label>
          <input
            id="role-password"
            className="surface control mono"
            type="password"
            autoComplete="new-password"
            placeholder={mode === "alter" ? "leave blank to keep" : "optional"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="button" className="type-chip" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={submit}
          disabled={busy || !nameValid}
        >
          {busy ? "Working…" : mode === "create" ? "Create role" : "Save changes"}
        </button>
      </div>
    </Surface>
  );
}

export default RolesClient;

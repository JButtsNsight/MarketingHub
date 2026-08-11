"use client";

import { useMemo, useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Surface } from "../Surface";
import { useConfirm, type ConfirmOptions } from "../ui/AlertDialog";

/**
 * Policies (Studio → Auth → Policies / Database → Policies): browse the live
 * RLS posture — per-table RLS state and every policy definition — and
 * create / alter / drop policies through the group-gated
 * /api/console/policies routes. A template picker prefills the create form
 * with the house starter policies.
 *
 * Reads (the coverage table + the policy list) are ungated. Every mutation is
 * DDL, so each one goes behind the interrupting confirm modal (useConfirm) —
 * the guard sits on the write, never on browsing.
 *
 * NOTE: Postgres cannot change a policy's command or action once created, so
 * the alter form edits only the name (rename), the TO-clause roles, and the
 * USING / WITH CHECK expressions. The USING / WITH CHECK fields are raw SQL
 * boolean expressions — the same trust boundary as the SQL editor.
 */

export interface PolicyTableDto {
  schema: string;
  name: string;
  rlsEnabled: boolean;
}

export interface PolicyDto {
  id: number;
  schema: string;
  table: string;
  name: string;
  /** PERMISSIVE | RESTRICTIVE */
  action: string;
  roles: string[];
  /** ALL | SELECT | INSERT | UPDATE | DELETE */
  command: string;
  definition: string | null;
  check: string | null;
}

export interface PolicyTemplatePrefill {
  name: string;
  command: string;
  action: string;
  /** Comma-separated role list; "" => TO public. */
  roles: string;
  using: string;
  check: string;
}

export interface PolicyTemplateDto {
  id: string;
  name: string;
  description: string;
  prefill: PolicyTemplatePrefill;
}

const COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const ACTIONS = ["PERMISSIVE", "RESTRICTIVE"] as const;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "a, b , c" -> ["a","b","c"]; empty => []. */
function parseRoles(input: string): string[] {
  return input
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

function policyKey(p: { schema: string; table: string; name: string }): string {
  return `${p.schema}.${p.table}.${p.name}`;
}

export function PoliciesClient({
  initialTables,
  initialPolicies,
  templates,
}: {
  initialTables: PolicyTableDto[];
  initialPolicies: PolicyDto[];
  templates: PolicyTemplateDto[];
}) {
  const [tables, setTables] = useState(initialTables);
  const [policies, setPolicies] = useState(initialPolicies);
  const [error, setError] = useState<string | null>(null);
  // The panels are mutually exclusive but tracked independently so a policy
  // literally named "new" can never collide with the create panel.
  const [creating, setCreating] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const closePanels = () => {
    setCreating(false);
    setEditingKey(null);
  };

  const reload = async () => {
    try {
      const res = await fetch("/api/console/policies");
      if (!res.ok) return;
      const body = (await res.json()) as {
        policies?: PolicyDto[];
        tables?: PolicyTableDto[];
      };
      if (body.policies) setPolicies(body.policies);
      if (body.tables) setTables(body.tables);
    } catch {
      // best-effort refresh; the panel/table keep the last good state
    }
  };

  const drop = async (policy: PolicyDto) => {
    const ok = await confirm({
      title: `Drop policy ${policy.name}?`,
      message: (
        <>
          This permanently removes the <strong>{policy.name}</strong> policy on{" "}
          <code className="mono">
            {policy.schema}.{policy.table}
          </code>
          . If it was the table&rsquo;s only policy, RLS stays enabled and the
          table becomes deny-all for anon/authenticated. This cannot be undone.
        </>
      ),
      confirmLabel: "Drop policy",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch("/api/console/policies", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: policy.schema,
          table: policy.table,
          name: policy.name,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Drop failed.");
        return;
      }
      await reload();
    } catch {
      setError("Network error — please try again.");
    }
  };

  const editing = editingKey
    ? (policies.find((p) => policyKey(p) === editingKey) ?? null)
    : null;

  const availableTables = useMemo(
    () =>
      [...tables].sort((a, b) =>
        `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
      ),
    [tables],
  );

  const tableColumns: Column<PolicyTableDto>[] = [
    {
      key: "table",
      header: "table",
      mono: true,
      render: (t) => `${t.schema}.${t.name}`,
    },
    {
      key: "rls",
      header: "rls",
      width: "110px",
      render: (t) =>
        t.rlsEnabled ? (
          <Badge tone="var(--ok)">enabled</Badge>
        ) : (
          <Badge tone="var(--fail)">disabled</Badge>
        ),
    },
  ];

  const policyColumns: Column<PolicyDto>[] = [
    { key: "name", header: "policy", mono: true },
    {
      key: "table",
      header: "table",
      mono: true,
      width: "220px",
      render: (p) => `${p.schema}.${p.table}`,
    },
    {
      key: "action",
      header: "action",
      width: "110px",
      render: (p) => (
        <Badge tone={p.action === "RESTRICTIVE" ? "var(--warn)" : undefined}>
          {p.action.toLowerCase()}
        </Badge>
      ),
    },
    { key: "command", header: "command", mono: true, width: "90px" },
    {
      key: "roles",
      header: "roles",
      mono: true,
      width: "160px",
      render: (p) => p.roles.join(", ") || "public",
    },
    {
      key: "definition",
      header: "using / check",
      mono: true,
      render: (p) => {
        const text = [p.definition, p.check].filter(Boolean).join(" · ") || "—";
        return (
          <span title={text}>
            {text.length > 48 ? `${text.slice(0, 47)}…` : text}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "150px",
      render: (p) => {
        const key = policyKey(p);
        return (
          <span className="campaign-actions">
            <button
              type="button"
              className="type-chip"
              onClick={() => {
                setCreating(false);
                setEditingKey(editingKey === key ? null : key);
              }}
            >
              {editingKey === key ? "Close" : "Edit"}
            </button>
            <button type="button" className="type-chip" onClick={() => void drop(p)}>
              Drop
            </button>
          </span>
        );
      },
    },
  ];

  const rlsEnabled = tables.filter((t) => t.rlsEnabled);
  const unprotected = tables.filter((t) => !t.rlsEnabled);

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard
          label="RLS enabled"
          value={rlsEnabled.length}
          hint={`of ${tables.length} tables`}
          accent="var(--data-3)"
        />
        <StatCard
          label="Unprotected"
          value={unprotected.length}
          hint={
            unprotected.length > 0
              ? unprotected.map((t) => t.name).join(", ")
              : "all covered"
          }
        />
        <StatCard label="Policies" value={policies.length} accent="var(--data-2)" />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section eyebrow="Tables" title="RLS coverage">
        <DataTable
          columns={tableColumns}
          rows={availableTables}
          getRowKey={(t) => `${t.schema}.${t.name}`}
          empty="No tables."
          paginate={50}
        />
      </Section>

      {creating ? (
        <PolicyForm
          key="new"
          mode="create"
          availableTables={availableTables}
          templates={templates}
          confirm={confirm}
          onDone={(changed) => {
            closePanels();
            if (changed) void reload();
          }}
        />
      ) : null}

      {editing ? (
        <PolicyForm
          key={policyKey(editing)}
          mode="alter"
          target={editing}
          availableTables={availableTables}
          templates={templates}
          confirm={confirm}
          onDone={(changed) => {
            closePanels();
            if (changed) void reload();
          }}
        />
      ) : null}

      <Section
        eyebrow="Policies"
        title="Active policies"
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditingKey(null);
              setCreating((v) => !v);
            }}
          >
            {creating ? "Close" : "New policy"}
          </button>
        }
      >
        <DataTable
          columns={policyColumns}
          rows={policies}
          getRowKey={(p) => policyKey(p)}
          empty="No policies reported."
          paginate={50}
        />
      </Section>
      {dialog}
    </div>
  );
}

/**
 * Create/alter form. Creating picks a table, command, action, roles and the
 * USING / WITH CHECK expressions, with a template picker that prefills the
 * fields. Altering a policy edits only what Postgres lets you change after
 * creation: the name (rename), the roles, and the two expressions.
 */
function PolicyForm({
  mode,
  target,
  availableTables,
  templates,
  confirm,
  onDone,
}: {
  mode: "create" | "alter";
  target?: PolicyDto;
  availableTables: PolicyTableDto[];
  templates: PolicyTemplateDto[];
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onDone: (changed: boolean) => void;
}) {
  const [tableKey, setTableKey] = useState<string>(
    target
      ? `${target.schema}.${target.table}`
      : availableTables[0]
        ? `${availableTables[0].schema}.${availableTables[0].name}`
        : "",
  );
  const [name, setName] = useState(target?.name ?? "");
  const [command, setCommand] = useState<string>(target?.command ?? "ALL");
  const [action, setAction] = useState<string>(target?.action ?? "PERMISSIVE");
  const [roles, setRoles] = useState<string>(target ? target.roles.join(", ") : "");
  const [using, setUsing] = useState<string>(target?.definition ?? "");
  const [check, setCheck] = useState<string>(target?.check ?? "");
  const [templateId, setTemplateId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setName(tpl.prefill.name);
    setCommand(tpl.prefill.command);
    setAction(tpl.prefill.action);
    setRoles(tpl.prefill.roles);
    setUsing(tpl.prefill.using);
    setCheck(tpl.prefill.check);
  };

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;

  const submit = async () => {
    setError(null);

    if (mode === "create") {
      if (!tableKey) {
        setError("Select a table for the policy.");
        return;
      }
      if (!IDENTIFIER_RE.test(name)) {
        setError(
          "Enter a valid policy name: a letter or underscore, then letters, digits or underscores.",
        );
        return;
      }
    } else if (name !== target!.name && !IDENTIFIER_RE.test(name)) {
      setError("Enter a valid policy name to rename to, or leave it unchanged.");
      return;
    }

    const dot = tableKey.indexOf(".");
    const schema = tableKey.slice(0, dot);
    const table = tableKey.slice(dot + 1);
    const roleList = parseRoles(roles);
    const usingExpr = using.trim() ? using : null;
    const checkExpr = check.trim() ? check : null;

    const ok = await confirm({
      title: mode === "create" ? `Create policy ${name}?` : `Alter policy ${name}?`,
      message:
        mode === "create" ? (
          <>
            Create the <strong>{name}</strong> policy on{" "}
            <code className="mono">{tableKey}</code> — a{" "}
            {action.toLowerCase()} policy for {command} to{" "}
            {roleList.length > 0 ? roleList.join(", ") : "public"}. This runs a
            DDL statement as <code className="mono">supabase_admin</code>.
          </>
        ) : (
          <>
            Apply changes to <strong>{target!.name}</strong> on{" "}
            <code className="mono">{tableKey}</code>. This alters who the policy
            applies to and the row conditions it enforces.
          </>
        ),
      confirmLabel: mode === "create" ? "Create policy" : "Save changes",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const body =
        mode === "create"
          ? {
              schema,
              table,
              name,
              command,
              action,
              roles: roleList,
              // Omit an empty expression: the API rejects "" and an absent
              // USING/CHECK simply leaves that clause off the policy.
              ...(usingExpr != null ? { using: usingExpr } : {}),
              ...(checkExpr != null ? { check: checkExpr } : {}),
            }
          : {
              schema,
              table,
              // Identify the policy by its CURRENT name; rename via newName.
              name: target!.name,
              ...(name !== target!.name ? { newName: name } : {}),
              roles: roleList,
              ...(usingExpr != null ? { using: usingExpr } : {}),
              ...(checkExpr != null ? { check: checkExpr } : {}),
            };
      const res = await fetch("/api/console/policies", {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(parsed?.error ?? "Request failed.");
        setBusy(false);
        return;
      }
      onDone(true);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">
        {mode === "create" ? "New policy" : `Alter ${target!.name}`}
      </span>

      {mode === "create" ? (
        <div className="field">
          <label htmlFor="pol-template">template</label>
          <select
            id="pol-template"
            className="surface control"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
          >
            <option value="">— start from scratch —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {selectedTemplate ? (
            <p className="panel-desc">{selectedTemplate.description}</p>
          ) : null}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="pol-table">table</label>
        {mode === "create" ? (
          <select
            id="pol-table"
            className="surface control mono"
            value={tableKey}
            onChange={(e) => setTableKey(e.target.value)}
          >
            {availableTables.length === 0 ? (
              <option value="">No tables available</option>
            ) : (
              availableTables.map((t) => {
                const key = `${t.schema}.${t.name}`;
                return (
                  <option key={key} value={key}>
                    {key}
                  </option>
                );
              })
            )}
          </select>
        ) : (
          <input
            id="pol-table"
            className="surface control mono"
            type="text"
            value={tableKey}
            disabled
            readOnly
          />
        )}
      </div>

      <div className="field">
        <label htmlFor="pol-name">name</label>
        <input
          id="pol-name"
          className="surface control mono"
          type="text"
          placeholder="policy_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {mode === "create" ? (
        <div className="dgrid-toolbar">
          <div className="field">
            <label htmlFor="pol-command">command</label>
            <select
              id="pol-command"
              className="surface control"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            >
              {COMMANDS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pol-action">action</label>
            <select
              id="pol-action"
              className="surface control"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div className="campaign-actions">
          <Badge>{command}</Badge>
          <Badge tone={action === "RESTRICTIVE" ? "var(--warn)" : undefined}>
            {action.toLowerCase()}
          </Badge>
          <span className="teditor-test">
            command &amp; action are fixed after creation
          </span>
        </div>
      )}

      <div className="field">
        <label htmlFor="pol-roles">roles</label>
        <input
          id="pol-roles"
          className="surface control mono"
          type="text"
          placeholder="public (comma-separated, e.g. authenticated, service_role)"
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pol-using">using expression</label>
        <textarea
          id="pol-using"
          className="surface control mono"
          rows={2}
          placeholder="e.g. (select auth.uid()) = user_id"
          value={using}
          onChange={(e) => setUsing(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pol-check">with check expression</label>
        <textarea
          id="pol-check"
          className="surface control mono"
          rows={2}
          placeholder="e.g. (select auth.uid()) = user_id"
          value={check}
          onChange={(e) => setCheck(e.target.value)}
        />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          className="type-chip"
          onClick={() => onDone(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {mode === "create" ? "Create policy" : "Save changes"}
        </button>
      </div>
    </Surface>
  );
}

export default PoliciesClient;

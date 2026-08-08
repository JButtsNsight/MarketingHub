import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { Surface } from "@/components/Surface";
import { KeyValue } from "@/components/ui/KeyValue";
import { Badge } from "@/components/ui/Badge";
import { StatusPill } from "@/components/ui/StatusPill";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { RefList, type RefRow } from "@/components/ui/RefList";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { AUTH_TABS } from "@/lib/console/tabs";
import { REFERENCE_DISCLAIMER } from "@/lib/console/backend-map";
import {
  GoTrueUnavailableError,
  getSettings,
  gotrueHealth,
  listSsoProviders,
  type GoTrueSettings,
  type SsoProvider,
} from "@/lib/console/gotrue";

// Reads request-time identity + live GoTrue settings; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auth Configuration · MarketingHub",
};

/**
 * Auth configuration (Studio → Authentication → Providers/Configuration
 * parity, Wave 3-partial). Server-rendered ONLY — no API route, no client
 * component: the page reads GET /auth/v1/settings, /admin/sso/providers and
 * /health through the server-only foundation lib and displays the result.
 *
 * STRICTLY DISPLAY-ONLY — hard Wave 3-partial program constraint. Wave 3
 * Auth is blocked on an external SAML deliverable, so this page carries ZERO
 * mutation affordances: no provider toggles, no SSO provider creation, no
 * template editing, no MFA changes. App sign-in is Cognito/SAML today;
 * GoTrue serves no login traffic until the Wave-3 cutover.
 *
 * Honest degradation: GoTrueUnavailableError → the "GoTrue unreachable"
 * state (W6 logs page pattern); any other lib failure → the stripped error,
 * displayed, with no sections pretending to be data.
 */

/** The six auth-flow email templates GoTrue reads from env-configured URLs. */
interface TemplateFlow {
  flow: string;
  templateVar: string;
  subjectVar: string;
}

const TEMPLATE_FLOWS: TemplateFlow[] = [
  "INVITE",
  "CONFIRMATION",
  "RECOVERY",
  "EMAIL_CHANGE",
  "MAGIC_LINK",
  "REAUTHENTICATION",
].map((flow) => ({
  flow: flow.replace(/_/g, " ").toLowerCase(),
  templateVar: `GOTRUE_MAILER_TEMPLATES_${flow}`,
  subjectVar: `GOTRUE_MAILER_SUBJECTS_${flow}`,
}));

const TEMPLATE_COLUMNS: Column<TemplateFlow>[] = [
  { key: "flow", header: "auth flow", width: "22%" },
  { key: "templateVar", header: "template env var", mono: true, width: "42%" },
  { key: "subjectVar", header: "subject env var", mono: true },
];

const SSO_COLUMNS: Column<SsoProvider>[] = [
  {
    key: "entity_id",
    header: "entity id",
    mono: true,
    width: "34%",
    render: (p) => p.saml.entity_id,
  },
  {
    key: "domains",
    header: "domains",
    mono: true,
    render: (p) =>
      p.domains.length ? p.domains.map((d) => d.domain).join(", ") : "—",
  },
  {
    key: "resource_id",
    header: "resource",
    mono: true,
    width: "16%",
    render: (p) => p.resource_id ?? "—",
  },
  {
    key: "status",
    header: "status",
    width: "12%",
    render: (p) =>
      p.disabled ? (
        <StatusPill status="idle">Disabled</StatusPill>
      ) : (
        <StatusPill status="ok">Active</StatusPill>
      ),
  },
  { key: "created_at", header: "created", mono: true, width: "18%" },
];

/**
 * MFA is honestly static here: per-user factors are read via the Users
 * detail, and the global policy is env-only with no read endpoint at the
 * pinned GoTrue — there is nothing live this page could truthfully show.
 */
const MFA_ROWS: RefRow[] = [
  {
    label: "Per-user factors",
    detail:
      "Enrolled factors (TOTP / phone / WebAuthn) are per-user records — GoTrue's admin API exposes them only per user, never in aggregate. They are shown read-only in a user's detail on the Users tab.",
    status: "info",
  },
  {
    label: "Global MFA policy",
    detail:
      "Factor-type enroll/verify toggles and limits are GOTRUE_MFA_* env vars on the auth container. GoTrue v2.186.0 has no admin endpoint that reads back its runtime config, so live values cannot be displayed here.",
    status: "info",
  },
];

export default async function AuthConfigPage() {
  // Server-side group gate first: the page fetches through the service-role
  // lib and never routes through an API handler, so it must gate itself.
  await requireMarketingUser();

  let settings: GoTrueSettings;
  let providers: SsoProvider[];
  let health: { version: string; name: string };
  try {
    [settings, providers, health] = await Promise.all([
      getSettings(),
      listSsoProviders(),
      gotrueHealth(),
    ]);
  } catch (err) {
    if (err instanceof GoTrueUnavailableError) {
      return (
        <>
          <PageHeader title="Auth configuration" />
          <Tabs items={AUTH_TABS} />
          <Surface className="empty-state" glint>
            <h2>GoTrue unreachable</h2>
            <p>
              The GoTrue auth service did not answer through Kong&apos;s
              always-on auth route, so its configuration and SSO providers
              cannot be read right now. App sign-in is Cognito and does not
              depend on GoTrue. Nothing else in the console is affected.
            </p>
          </Surface>
        </>
      );
    }
    // GoTrue answered but the read failed (e.g. a misconfigured service key)
    // — show the honest, actionable message instead of fake sections.
    const message =
      err instanceof Error
        ? err.message.replace(/^\[console:[\w-]+\] (?:[\w-]+ failed: )?/, "")
        : "GoTrue configuration read failed.";
    return (
      <>
        <PageHeader title="Auth configuration" />
        <Tabs items={AUTH_TABS} />
        <Surface className="empty-state" glint>
          <h2>Configuration unreadable</h2>
          <p role="alert">{message}</p>
        </Surface>
      </>
    );
  }

  // Enabled-first, then alphabetical within each group.
  const providerNames = Object.keys(settings.external).sort((a, b) =>
    a.localeCompare(b),
  );
  const enabledProviders = providerNames.filter((n) => settings.external[n]);
  const disabledProviders = providerNames.filter((n) => !settings.external[n]);

  return (
    <>
      <PageHeader
        title="Auth configuration"
        count={`GoTrue ${health.version}`}
      />
      <Tabs items={AUTH_TABS} />

      <div className="stack">
        <Section
          eyebrow="Providers"
          title="Sign-in providers"
          description="Live flags from GoTrue's settings endpoint. App identity is Cognito/SAML today — these providers serve no login traffic, and their config is env-only on the auth container (display-only here)."
        >
          <KeyValue
            items={[
              {
                label: "Enabled providers",
                value: enabledProviders.length ? (
                  <span className="filter-group">
                    {enabledProviders.map((name) => (
                      <Badge key={name} tone="var(--data-3)">
                        {name}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "none"
                ),
              },
              {
                label: "Disabled providers",
                value: disabledProviders.length
                  ? disabledProviders.join(", ")
                  : "none",
                mono: true,
              },
              {
                label: "Public signups",
                value: settings.disable_signup
                  ? "Disabled (disable_signup)"
                  : "Enabled",
              },
              {
                label: "Email autoconfirm",
                value: settings.mailer_autoconfirm ? "On" : "Off",
              },
              {
                label: "Phone autoconfirm",
                value: settings.phone_autoconfirm ? "On" : "Off",
              },
              {
                label: "SMS provider",
                value: settings.sms_provider || "none configured",
                mono: settings.sms_provider !== "",
              },
            ]}
          />
        </Section>

        <Section
          eyebrow="SSO"
          title="SSO / SAML"
          description="Registered SAML identity providers in GoTrue. Providers are created and changed only by a deliberate operator action — never from this console."
        >
          <KeyValue
            items={[
              {
                label: "SAML capability",
                value: settings.saml_enabled
                  ? "Enabled (saml_enabled)"
                  : "Disabled (saml_enabled=false)",
              },
            ]}
          />
          {providers.length ? (
            <DataTable
              columns={SSO_COLUMNS}
              rows={providers}
              getRowKey={(p) => p.id}
            />
          ) : (
            <Surface className="empty-state" glint>
              <h2>No SSO providers</h2>
              <p>
                GoTrue has no SAML identity provider registered. The external
                SAML deliverable (IdP metadata from the identity provider
                side) is still pending — that cutover is Wave 3&apos;s blocked
                remainder. Until it lands, sign-in stays on Cognito and this
                list is honestly empty.
              </p>
            </Surface>
          )}
        </Section>

        <Section
          eyebrow="Email"
          title="Email templates"
          description="Self-hosted GoTrue reads each auth email template from an env-configured URL — these are the variable names, not live values."
        >
          <DataTable
            columns={TEMPLATE_COLUMNS}
            rows={TEMPLATE_FLOWS}
            getRowKey={(t) => t.templateVar}
          />
          <p className="ref-note" style={{ marginTop: "14px" }}>
            <Badge>reference</Badge>
            <span>
              {REFERENCE_DISCLAIMER} Template values are URLs GoTrue fetches
              at send time; it exposes no read API for them, so template
              content is not viewable from this console.
            </span>
          </p>
        </Section>

        <Section
          eyebrow="MFA"
          title="Multi-factor authentication"
          description="Where MFA state actually lives at the pinned GoTrue — per-user factors in the Users detail, global policy in env."
        >
          <RefList items={MFA_ROWS} />
        </Section>
      </div>
    </>
  );
}

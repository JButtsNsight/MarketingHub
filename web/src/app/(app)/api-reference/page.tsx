import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { API_SURFACES, type ApiSurface } from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

const SURFACE_COLUMNS: Column<ApiSurface>[] = [
  { key: "name", header: "surface", width: "24%" },
  { key: "base", header: "base path", mono: true, width: "28%" },
  { key: "note", header: "notes" },
];

const REST_EXAMPLE = `curl "$SUPABASE_URL/rest/v1/templates?select=id,name,type&order=created_at.desc" \\
  -H "Accept-Profile: marketinghub" \\
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \\
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"`;

const GRAPHQL_EXAMPLE = `curl "$SUPABASE_URL/graphql/v1" \\
  -H "Content-Type: application/json" \\
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \\
  -d '{"query":"{ templatesCollection { edges { node { id name type } } } }"}'`;

export default async function ApiReferencePage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader
        eyebrow="API"
        title="Data API"
      />

      <div className="stack">
        <Section eyebrow="Endpoints" title="Exposed surfaces">
          <DataTable
            columns={SURFACE_COLUMNS}
            rows={API_SURFACES}
            getRowKey={(s) => s.name}
          />
          <p className="ref-note">
            <Badge>note</Badge>
            <span>
              The data API is <strong>private</strong> (internal ALB → Kong, ACM
              Private CA TLS). The <code>service_role</code> key is server-only —
              it is never sent to the browser; this console proxies every call
              server-side after the Cognito group gate.
            </span>
          </p>
        </Section>

        <Section
          eyebrow="Example"
          title="PostgREST — list templates"
          description="Reading marketinghub.templates requires the Accept-Profile header (the schema is not the default public)."
        >
          <CodeBlock label="REST" code={REST_EXAMPLE} />
        </Section>

        <Section
          eyebrow="Example"
          title="GraphQL — templates collection"
          description="pg_graphql serves the graphql_public schema."
        >
          <CodeBlock label="GraphQL" code={GRAPHQL_EXAMPLE} />
        </Section>
      </div>
    </>
  );
}

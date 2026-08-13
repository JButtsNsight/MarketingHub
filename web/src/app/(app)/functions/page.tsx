import { PageHeader } from "@/components/ui/PageHeader";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { requireSectionUser } from "@/lib/requireSection";
import { getUserClient } from "@/lib/supabase";
import {
  FunctionsConsole,
  type EdgeFunctionRow,
} from "@/components/console/FunctionsConsole";

// Reads request-time identity + live registry rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edge Functions · MarketingHub",
};

/**
 * Edge Functions console (Studio parity, Wave 5). The registry table
 * `marketinghub.edge_functions` — not the host filesystem — is the source of
 * truth for names/versions/source (app containers cannot read the
 * edge-runtime volume). Invocations run through the server-side proxy at
 * /api/console/functions/invoke.
 */
export default async function FunctionsPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;
  const { user } = gate;

  // The registry table may predate its migration on a fresh environment —
  // an honest empty console beats a hard 500.
  let functions: EdgeFunctionRow[] = [];
  try {
    const db = await getUserClient(user);
    const { data, error } = await db
      .schema("marketinghub")
      .from("edge_functions")
      .select("name, version, updated_at, deployed_at, notes, source")
      .order("name", { ascending: true });
    if (!error && Array.isArray(data)) {
      functions = data as EdgeFunctionRow[];
    }
  } catch {
    // rendered empty; invoking will surface real errors
  }

  return (
    <>
      <Guide id="integrations.functions.page">
        <PageHeader title="Edge Functions" />
      </Guide>
      <FunctionsConsole initialFunctions={functions} />
    </>
  );
}

import { PageHeader } from "@/components/ui/PageHeader";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
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
  // Server-side group gate: mirrors the API handlers.
  const user = await requireMarketingUser();

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
      <PageHeader title="Edge Functions" />
      <FunctionsConsole initialFunctions={functions} />
    </>
  );
}

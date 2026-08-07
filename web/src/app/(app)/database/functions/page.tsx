import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listFunctions } from "@/lib/console/dbobjects";
import { DB_TABS } from "@/lib/console/tabs";
import {
  FunctionsClient,
  type PgFunctionDto,
} from "@/components/console/FunctionsClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Functions · MarketingHub",
};

/** Routines the Functions page surfaces (matches the surface spec). */
const FUNCTION_SCHEMAS = ["marketinghub", "public", "pgmq_public"];

/**
 * Database → Functions (Studio parity). Live routines from pg_proc across
 * marketinghub / public / pgmq_public — name, args, return type, language, and
 * the SECURITY DEFINER flag. The client island owns viewing a definition (a
 * read) and dropping a function (DDL, behind the confirm modal), all through
 * the group-gated /api/console/functions route.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function FunctionsPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let functions: PgFunctionDto[] | null = null;
  try {
    functions = await listFunctions(FUNCTION_SCHEMAS);
  } catch {
    functions = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Functions" />
      <Tabs items={DB_TABS} />

      {functions ? (
        <FunctionsClient initialFunctions={functions} />
      ) : (
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      )}
    </>
  );
}

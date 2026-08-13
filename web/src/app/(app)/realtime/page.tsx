import { PageHeader } from "@/components/ui/PageHeader";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { requireSectionUser } from "@/lib/requireSection";
import { RealtimeInspector } from "@/components/console/RealtimeInspector";

// Request-time identity gate; the inspector itself is fully client-side.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Realtime · MarketingHub",
};

/**
 * Realtime Inspector (Studio → Realtime parity). Everything runs through the
 * Wave-5 foundation wrapper in the browser; until the operator applies the W5
 * migration + ALB rule + env, the console renders its honest
 * "Realtime unreachable" state and nothing else in the app changes.
 */
export default async function RealtimePage() {
  // Server-side section gate: mirrors the /api/realtime/token handler.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;
  const { user } = gate;

  return (
    <>
      <Guide id="integrations.realtime.page">
        <PageHeader title="Realtime" />
      </Guide>
      <RealtimeInspector userEmail={user.email} />
    </>
  );
}

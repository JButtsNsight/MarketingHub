import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { countUnhandledInbound, listInboundMessages } from "@/lib/sms/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxTable } from "@/components/campaigns/InboxTable";

// Reads request-time identity + live inbox rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Inbox · MarketingHub",
};

/**
 * The reply inbox: every inbound SMS captured by the webhook's inbound lane,
 * newest first, best-effort attributed to the campaign that prompted it.
 * `?filter=unhandled` narrows to the rows still needing a human.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't
  // be browsed by an authenticated employee outside the `marketing` group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const { filter } = await searchParams;
  const unhandledOnly = filter === "unhandled";

  const [messages, unhandled] = await Promise.all([
    listInboundMessages({ unhandledOnly }, db),
    countUnhandledInbound(db),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Engage"
        title="Inbox"
        count={
          unhandled > 0
            ? `${unhandled} need${unhandled === 1 ? "s" : ""} a reply`
            : "all handled"
        }
        actions={
          <>
            <Link
              className={unhandledOnly ? "type-chip" : "type-chip on"}
              href="/inbox"
            >
              All
            </Link>
            <Link
              className={unhandledOnly ? "type-chip on" : "type-chip"}
              href="/inbox?filter=unhandled"
            >
              Unhandled
            </Link>
          </>
        }
      />

      <InboxTable messages={messages} />
    </>
  );
}

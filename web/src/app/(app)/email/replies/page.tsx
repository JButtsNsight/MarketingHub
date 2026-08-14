import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Guide } from "@/components/guide/Guide";
import { RepliesList } from "@/components/email/RepliesList";
import { EMAIL_TABS } from "@/components/email/tabs";

// Reads request-time identity + the live EmailBison connection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Email Replies · MarketingHub",
};

/** Master Inbox — EmailBison's shared reply inbox, read-only, marketing tier. */
export default async function EmailRepliesPage() {
  await requireMarketingUser();
  return (
    <div>
      <PageHeader title="Master Inbox" />
      <Guide id="email.center.tabs">
        <Tabs items={EMAIL_TABS} />
      </Guide>
      <RepliesList />
    </div>
  );
}

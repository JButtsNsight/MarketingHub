import { TemplatesView } from "@/components/templates/TemplatesView";
import { SMS_TABS } from "@/components/sms/tabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "SMS Templates · MarketingHub",
};

/** SMS templates — the Templates tab of the SMS section (type locked to text).
 *  Direct async call (not JSX) so the resolved tree is returned — same output
 *  in Next, and unit tests can render it without a server-component runtime. */
export default async function SmsTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return TemplatesView({
    searchParams,
    lockedType: "text",
    tabs: SMS_TABS,
    tabsGuideId: "campaigns.shell.tabs",
  });
}

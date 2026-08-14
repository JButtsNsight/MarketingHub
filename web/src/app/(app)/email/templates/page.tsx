import { TemplatesView } from "@/components/templates/TemplatesView";
import { EMAIL_TABS } from "@/components/email/tabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Email Templates · MarketingHub",
};

/** Email templates — the Templates tab of the Email section (type locked).
 *  Direct async call (not JSX) so the resolved tree is returned — same output
 *  in Next, and unit tests can render it without a server-component runtime. */
export default async function EmailTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return TemplatesView({
    searchParams,
    lockedType: "email",
    tabs: EMAIL_TABS,
    tabsGuideId: "email.center.tabs",
  });
}

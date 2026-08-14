import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { isAdmin } from "@/lib/authGroups";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmailCenter } from "@/components/email/EmailCenter";

// Reads request-time identity + the live EmailBison connection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Email Campaigns · MarketingHub",
};

/** Email Campaign Center — EmailBison-backed, marketing tier. */
export default async function EmailPage() {
  const user = await requireMarketingUser();
  return (
    <div>
      <PageHeader title="Email Campaigns" />
      <EmailCenter admin={isAdmin(user)} />
    </div>
  );
}

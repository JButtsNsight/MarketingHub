import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { NewListForm } from "@/components/campaigns/NewListForm";

// Reads request-time identity; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "New contact list · MarketingHub",
};

/**
 * Contact-list creation page. Server component shell around the client form.
 * No Monday gate here: uploading a sheet needs no integration at all, and the
 * Monday tab degrades with its own callout when the token is unset.
 */
export default async function NewContactListPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  return (
    <div className="page-narrow">
      <NewListForm />
    </div>
  );
}

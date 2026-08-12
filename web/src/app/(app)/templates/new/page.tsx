import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { UploadForm } from "@/components/templates/UploadForm";

export const metadata = {
  title: "Upload template · MarketingHub",
};

// Reads request-time identity for the gate; never prerender.
export const dynamic = "force-dynamic";

/**
 * Upload page, gated like every other marketing page: the ALB federates the
 * whole Google Workspace, so without `requireMarketingUser()` any signed-in
 * employee would see a working-looking form whose group-gated POST
 * (`/api/templates`) can only 403. The API stays the real write authz.
 */
export default async function NewTemplatePage() {
  await requireMarketingUser();
  return (
    <div className="page-narrow">
      <UploadForm />
    </div>
  );
}

import { UploadForm } from "@/components/templates/UploadForm";

export const metadata = {
  title: "Upload template · MarketingHub",
};

/**
 * Upload page. The form is a client component that posts to the group-gated
 * `/api/templates` route; the ALB + server-side `requireUser` are the real
 * authz gate, so this page needs no client-side guard.
 */
export default function NewTemplatePage() {
  return (
    <div className="page-narrow">
      <UploadForm />
    </div>
  );
}

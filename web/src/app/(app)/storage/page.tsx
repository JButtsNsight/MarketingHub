import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  listBucket,
  listBuckets,
  CAMPAIGN_BUCKET,
} from "@/lib/console/storage";
import { StorageBrowser } from "@/components/console/StorageBrowser";

// Reads request-time identity + live bucket listings; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Storage · MarketingHub",
};

/**
 * The Storage browser (Studio parity): every bucket, upload/rename/delete/
 * preview/download. Objects are proxied through the console via short-lived
 * signed URLs — the internal data API stays private.
 */
export default async function StoragePage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let buckets: Awaited<ReturnType<typeof listBuckets>> = [];
  let entries: Awaited<ReturnType<typeof listBucket>> = [];
  let initialBucket = CAMPAIGN_BUCKET;
  try {
    buckets = await listBuckets();
    if (buckets.length > 0 && !buckets.some((b) => b.name === initialBucket)) {
      initialBucket = buckets[0].name;
    }
    if (buckets.length > 0) {
      entries = await listBucket("", initialBucket);
    }
  } catch {
    buckets = [];
  }

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title="Storage"
        subtitle="Private buckets — objects are proxied through the console via short-lived signed URLs. Uploads never overwrite; replacing a file is an explicit delete-then-upload."
        count={`${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`}
      />

      {buckets.length > 0 ? (
        <StorageBrowser
          initialBuckets={buckets}
          initialBucket={initialBucket}
          initialEntries={entries}
        />
      ) : (
        <Surface className="empty-state" glint>
          <h2>Storage unavailable</h2>
          <p>
            The Storage API did not answer (or no buckets exist yet) — refresh
            in a moment.
          </p>
        </Surface>
      )}
    </>
  );
}

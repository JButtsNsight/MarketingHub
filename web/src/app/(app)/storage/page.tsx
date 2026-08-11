import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/Surface";
import { Section } from "@/components/ui/Section";
import { KeyValue } from "@/components/ui/KeyValue";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  listBucket,
  listBuckets,
  CAMPAIGN_BUCKET,
} from "@/lib/console/storage";
import { StorageBrowser } from "@/components/console/StorageBrowser";
import { BucketManager } from "@/components/storage/BucketManager";

// Reads request-time identity + live bucket listings; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Storage · MarketingHub",
};

/**
 * The Storage browser (Studio parity): every bucket, upload/rename/delete/
 * preview/download, bucket management, resumable (TUS) uploads, and image
 * transform previews. Objects are proxied through the console via short-lived
 * signed URLs — the internal data API stays private.
 */
export default async function StoragePage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let buckets: Awaited<ReturnType<typeof listBuckets>> = [];
  let entries: Awaited<ReturnType<typeof listBucket>> = [];
  let initialBucket = CAMPAIGN_BUCKET;
  let storageUp = true;
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
    storageUp = false;
  }

  // Read-only S3-protocol facts (what Studio's storage settings show). The
  // endpoint hangs off the internal Supabase URL — that origin (and any other
  // host-identifying env) must never render into browser-served HTML, so the
  // rows below are static placeholders; ops docs carry the literal values.
  return (
    <>
      <PageHeader
        eyebrow="Build"
        title="Storage"
        count={`${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`}
      />

      {buckets.length > 0 ? (
        <StorageBrowser
          initialBuckets={buckets}
          initialBucket={initialBucket}
          initialEntries={entries}
        />
      ) : (
        <>
          <Surface className="empty-state" glint>
            <h2>Storage unavailable</h2>
            <p>
              The Storage API did not answer (or no buckets exist yet) —
              refresh in a moment.
            </p>
          </Surface>
          {storageUp ? (
            // The API is up but bucketless — offer the create path (the full
            // browser appears on the next load once a bucket exists).
            <BucketManager initialBuckets={[]} />
          ) : null}
        </>
      )}

      <Section
        eyebrow="storage"
        title="S3 protocol"
        description="S3-compatible API, reachable from inside the VPC only."
      >
        <KeyValue
          items={[
            {
              label: "endpoint",
              value: "<SUPABASE_URL>/storage/v1/s3",
              mono: true,
            },
            {
              label: "region",
              value:
                "Host-managed — STORAGE_S3_REGION is set on the Supabase host.",
            },
            { label: "auth", value: "SigV4 (AWS Signature Version 4)" },
            {
              label: "credentials",
              value:
                "Host-managed — S3_PROTOCOL_ACCESS_KEY_ID / S3_PROTOCOL_ACCESS_KEY_SECRET are set on the Supabase host and are never exposed through this console.",
            },
          ]}
        />
      </Section>
    </>
  );
}

import "server-only";

import { getServiceClient } from "../supabase";

/** The one logical Supabase Storage bucket the app owns. */
export const CAMPAIGN_BUCKET = "campaign-templates";

const SIGNED_URL_TTL = 60 * 5;

export interface StorageEntry {
  name: string;
  /** null id => a folder/prefix (Supabase lists nested keys as pseudo-folders). */
  isFolder: boolean;
  size: number | null;
  mimetype: string | null;
  updatedAt: string | null;
  /** Full object path (prefix + name), used for drill-down and signing. */
  path: string;
}

/**
 * List one level of the campaign-templates bucket at `prefix`. Objects are
 * stored under `<template-id>/<file>`, so the root lists template-id folders and
 * drilling into one lists its files. Fail-loud on any Storage API error.
 */
export async function listBucket(prefix = ""): Promise<StorageEntry[]> {
  const { data, error } = await getServiceClient()
    .storage.from(CAMPAIGN_BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error(`[console:storage] list failed: ${error.message}`);

  return (data ?? []).map((obj) => {
    const meta = (obj.metadata ?? {}) as {
      size?: number;
      mimetype?: string;
    };
    const isFolder = obj.id == null;
    return {
      name: obj.name,
      isFolder,
      size: typeof meta.size === "number" ? meta.size : null,
      mimetype: typeof meta.mimetype === "string" ? meta.mimetype : null,
      updatedAt: obj.updated_at ?? null,
      path: prefix ? `${prefix}/${obj.name}` : obj.name,
    };
  });
}

/** A short-lived signed download URL for an object in the bucket. Fail-loud. */
export async function signObject(path: string): Promise<string> {
  const { data, error } = await getServiceClient()
    .storage.from(CAMPAIGN_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error) throw new Error(`[console:storage] sign failed: ${error.message}`);
  return (data as { signedUrl: string }).signedUrl;
}

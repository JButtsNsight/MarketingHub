import "server-only";

import { getServiceClient } from "../supabase";
import type { ParsedContact } from "./csv";
import type { ContactList, ContactListMember } from "./schema";

/**
 * Data access for contact lists — the reusable recipient sources behind the
 * campaign builder. Same house rules as the other repos: `marketinghub`
 * schema via the service-role PostgREST client, fail loud on unexpected
 * PostgREST errors, app-maintained updated_at.
 */

const SCHEMA = "marketinghub";
const LISTS = "contact_lists";
const MEMBERS = "contact_list_members";
/** Private Supabase Storage bucket holding the raw uploaded sheets. */
const BUCKET = "contact-lists";
/** Member rows per insert statement at creation time. */
const INSERT_CHUNK = 200;
/** Member rows served to the detail UI. */
const MEMBER_LIMIT = 2000;

export interface ListCreator {
  email: string;
}

function lists() {
  return getServiceClient().schema(SCHEMA).from(LISTS);
}

function members() {
  return getServiceClient().schema(SCHEMA).from(MEMBERS);
}

function fail(op: string, message: string): never {
  throw new Error(`[contact-lists] ${op} failed: ${message}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Storage-safe basename (same rule as the templates repo). */
function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Create a CSV-sourced list: the list row first, then the raw file into the
 * private bucket, then the parsed members in chunks of 200. NOT transactional
 * (PostgREST has no multi-statement transactions) — on a member-insert
 * failure the list row is best-effort deleted (cascade removes any inserted
 * members) and the error is re-thrown, so a half-loaded list never lingers.
 */
export async function createCsvList(
  name: string,
  contacts: ParsedContact[],
  file: { filename: string; content: string },
  user: ListCreator,
): Promise<ContactList> {
  const counts = { ok: 0, invalid: 0, duplicate: 0 };
  for (const c of contacts) counts[c.reason] += 1;

  const { data, error } = await lists()
    .insert({
      name,
      source: "csv",
      // The check constraint needs storage_path at insert; the object is
      // uploaded to exactly this path right after.
      storage_path: "pending",
      original_filename: file.filename,
      contact_count: counts.ok,
      invalid_count: counts.invalid,
      duplicate_count: counts.duplicate,
      created_by: user.email,
    })
    .select()
    .single();
  if (error) fail("create", error.message);
  let list = data as ContactList;

  const cleanup = async () => {
    try {
      await lists().delete().eq("id", list.id);
    } catch {
      // the original failure is the one worth surfacing
    }
  };

  const storagePath = `${list.id}/${safeFilename(file.filename)}`;
  const { error: uploadError } = await getServiceClient()
    .storage.from(BUCKET)
    .upload(storagePath, file.content, {
      contentType: "text/csv",
      upsert: true,
    });
  if (uploadError) {
    await cleanup();
    fail("upload", uploadError.message);
  }

  const { data: updated, error: pathError } = await lists()
    .update({ storage_path: storagePath, updated_at: nowIso() })
    .eq("id", list.id)
    .select()
    .single();
  if (pathError) {
    await cleanup();
    fail("update-storage-path", pathError.message);
  }
  list = updated as ContactList;

  const rows = contacts.map((c) => ({
    list_id: list.id,
    name: c.name,
    first_name: c.firstName,
    phone_e164: c.phoneE164,
    raw_phone: c.rawPhone,
    reason: c.reason,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { error: insertError } = await members().insert(chunk);
    if (insertError) {
      await cleanup();
      fail("create-members", `chunk at ${i}: ${insertError.message}`);
    }
  }

  return list;
}

/** Create a Monday-linked list (members are fetched live at campaign time). */
export async function createMondayList(
  name: string,
  board: { id: string; name: string; phoneColumnId: string },
  user: ListCreator,
): Promise<ContactList> {
  const { data, error } = await lists()
    .insert({
      name,
      source: "monday",
      monday_board_id: board.id,
      monday_board_name: board.name,
      monday_phone_column_id: board.phoneColumnId,
      created_by: user.email,
    })
    .select()
    .single();
  if (error) fail("create-monday", error.message);
  return data as ContactList;
}

/** All lists, newest first. */
export async function listContactLists(): Promise<ContactList[]> {
  const { data, error } = await lists()
    .select("*")
    .order("created_at", { ascending: false });
  if (error) fail("list", error.message);
  return (data ?? []) as ContactList[];
}

/** Fetch one list, or null if it does not exist. */
export async function getContactList(id: string): Promise<ContactList | null> {
  const { data, error } = await lists().select("*").eq("id", id).maybeSingle();
  if (error) fail("get", error.message);
  return (data as ContactList) ?? null;
}

/** Members of a CSV list in upload order, capped for the UI. */
export async function getListMembers(
  listId: string,
): Promise<ContactListMember[]> {
  const { data, error } = await members()
    .select("*")
    .eq("list_id", listId)
    .order("created_at", { ascending: true })
    .limit(MEMBER_LIMIT);
  if (error) fail("get-members", error.message);
  return (data ?? []) as ContactListMember[];
}

/** Sendable members of a CSV list (reason ok, phone present), unbounded. */
export async function getSendableMembers(
  listId: string,
): Promise<ContactListMember[]> {
  const { data, error } = await members()
    .select("*")
    .eq("list_id", listId)
    .eq("reason", "ok")
    .order("created_at", { ascending: true });
  if (error) fail("get-sendable", error.message);
  return (data ?? []) as ContactListMember[];
}

/**
 * Whether any campaign (whatever its status) was created from this list —
 * `sms_campaigns.contact_list_id` has no ON DELETE clause, so deleting a
 * referenced list would fail at the FK anyway; this makes it a clean 409.
 */
export async function listIsReferenced(id: string): Promise<boolean> {
  const { data, error } = await getServiceClient()
    .schema(SCHEMA)
    .from("sms_campaigns")
    .select("id")
    .eq("contact_list_id", id)
    .limit(1);
  if (error) fail("is-referenced", error.message);
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

/**
 * Delete a list. Members cascade in the DB; the stored file is removed
 * best-effort (an orphaned object is a cleanup chore, not a correctness
 * problem). Returns false when the list did not exist.
 */
export async function deleteContactList(id: string): Promise<boolean> {
  const existing = await getContactList(id);
  if (!existing) return false;

  const { error } = await lists().delete().eq("id", id);
  if (error) fail("delete", error.message);

  if (existing.storage_path && existing.storage_path !== "pending") {
    try {
      await getServiceClient().storage.from(BUCKET).remove([existing.storage_path]);
    } catch {
      // best-effort — the row (and members) are already gone
    }
  }
  return true;
}

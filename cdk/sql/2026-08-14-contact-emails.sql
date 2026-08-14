-- cdk/sql/2026-08-14-contact-emails.sql
-- MarketingHub — contact_list_members learns an EMAIL address so contact
-- lists can serve as email-campaign recipient sources.
--
-- ADDITIVE ONLY: SMS semantics are untouched — phone_e164, raw_phone, the
-- reason classification (ok|invalid|duplicate stays phone-only), and
-- unique(list_id, phone_e164) all behave exactly as before. The SMS send
-- path filters on reason = 'ok' and never reads this column.
--
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
-- Applied AFTER 2026-07-30-contact-lists.sql (and the rest of the chain).
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema and won't see the new column until it reloads.

alter table marketinghub.contact_list_members
  add column if not exists email text not null default '';

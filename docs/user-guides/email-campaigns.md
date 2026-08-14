# Email Campaigns — user guide

*For the marketing team. Paste-friendly for Confluence or email. Last updated 2026-08-14.*

MarketingHub's **Email Campaigns** page is your one dashboard for everything
happening in EmailBison, the platform we use for email marketing. You'll find
it in the left menu under **Marketing**.

## What you can do here

- **See every email campaign** and its live numbers in one table: leads,
  emails sent, opens, replies, people marked interested, bounces, and
  unsubscribes.
- **Filter by status** (active, paused, completed, and so on) with the
  dropdown at the top right.
- **Jump into EmailBison** with the "Open EmailBison" link when you need to do
  more than look — edit a sequence, reply to a prospect, launch or pause a
  campaign. Today, all *changes* to campaigns happen in EmailBison itself;
  this page is your read-only mission control.

Numbers are live from EmailBison every time you load or filter the page.

## Tips

- **Turn on the graduation cap** (top right of any page) and hover anything
  on the page for a plain-English explanation of what it does.
- "Opens" and "Replies" count **unique people**, not raw events — one prospect
  opening five times counts once.
- The **Updated** column is the last time the campaign itself changed in
  EmailBison, not the last send.

## If the page says "Not connected"

The EmailBison account link hasn't been set up (or was removed). Ask an
admin — connecting takes about a minute:

1. In EmailBison: **Settings → Developer API → New API Token** (make an
   "api-user" token in the workspace you want to show here).
2. In MarketingHub → Email Campaigns: enter the EmailBison web address
   (`dedi.emailbison.com` unless we've moved to our own instance) and paste
   the token, then click **Connect**.
3. The token is tested against EmailBison before it's saved — if it's wrong
   you'll get a clear error and nothing changes. When it works, the dashboard
   appears immediately for everyone.

To swap in a new token later, just connect again with the new one. To remove
the link entirely, admins have a **Disconnect** action — it only removes the
stored token; nothing in EmailBison is touched.

## If something looks wrong

- **"EmailBison rejected the API token"** — the token was revoked or expired
  in EmailBison. An admin should mint a fresh token and reconnect (steps
  above).
- **Numbers look stale or a campaign is missing** — check the status filter
  first (a blank filter shows everything). The token only sees one EmailBison
  workspace; campaigns in another workspace need that workspace's token.
- **Anything else** — grab Justin's team with a screenshot; the page's error
  messages say exactly what upstream reported.

## What this page deliberately doesn't do (yet)

Creating campaigns, editing sequences, pushing MarketingHub contact lists
into EmailBison, and reading replies all still live in EmailBison itself.
If one of those inside MarketingHub would save you real time, say so — the
plumbing is already built for it.

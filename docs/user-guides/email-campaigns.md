# Email Campaigns — user guide

*For the marketing team. Paste-friendly for Confluence or email. Last updated 2026-08-14.*

MarketingHub's **Email Campaigns** page is your dashboard for EmailBison, the
platform we use for email marketing. You'll find it in the left menu under
**Marketing**. It has two tabs, named the same way EmailBison names them so
nothing you already know goes to waste:

- **Campaigns** — every campaign with its live numbers, plus pause/resume,
  contact pushes, and draft creation.
- **Master Inbox** — EmailBison's shared reply inbox, read-only.
- **Templates** — the email half of the template library (SMS templates live
  under SMS Campaigns → Templates).

## What you can do here

- **See every email campaign** and its live numbers in one table: leads,
  emails sent, opens, replies, people marked interested, bounces, and
  unsubscribes — the same stats, in the same order, as EmailBison.
- **Pause and resume campaigns** right from the table. Pause takes effect
  immediately; Resume asks you to confirm first, because emails start going
  out again as soon as EmailBison picks the campaign back up.
- **Push a contact list into a campaign.** Pick any CSV-uploaded contact list
  (the same lists the SMS side uses) and its members are added to the campaign
  as EmailBison leads. On **active** campaigns EmailBison syncs new leads on a
  roughly 5-minute cycle — give it a few minutes before you go looking.
  Monday-backed lists can't be pushed yet; only sheet-uploaded lists work.
- **Create a campaign** with the **New campaign** button. It's created in
  EmailBison as a Draft with just the name — you then write the sequence, set
  the schedule, and pick sender emails in EmailBison and launch it there.
- **Read replies in the Master Inbox** — the same folders as EmailBison
  (Inbox, Sent, Spam, Bounces), Interested and Bounce labels on each thread,
  unread replies in bold, with a filter for interested / automated / human
  replies. Reading only — to answer someone, use the "Open in EmailBison"
  link.
- **Filter by status** (Draft, Launching, Active, Paused, Stopped, Completed,
  Failed) with the dropdown at the top right.
- **Jump into EmailBison** with the "Open in EmailBison" link for the deep
  work that deliberately stays there — sequences, schedules, sender emails,
  and replying.

Numbers are live from EmailBison every time you load or filter the page, and
the table refreshes itself after every action so it never shows you a guess.

## Tips

- **Turn on the graduation cap** (top right of any page) and hover anything
  on the page for a plain-English explanation of what it does.
- "Opens" and "Replies" count **unique people**, not raw events — one prospect
  opening five times counts once.
- The **Updated** column is the last time the campaign itself changed in
  EmailBison, not the last send.
- After a contact push, the success line tells you how many leads were
  attached and how many were skipped (members without a usable email address).

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
- **A pause/resume/push failed** — the error line under the header quotes
  exactly what EmailBison reported, with a Retry link, and your table data
  stays put. If a push fails partway, the error says how many leads already
  reached EmailBison and confirms retrying is safe — saved leads update
  rather than duplicate, so just push again.
- **Pushed leads aren't showing** — on active campaigns EmailBison picks up
  attached leads on a ~5-minute sync. Check again in a few minutes before
  assuming the push failed.
- **Numbers look stale or a campaign is missing** — check the status filter
  first (a blank filter shows everything). The token only sees one EmailBison
  workspace; campaigns in another workspace need that workspace's token.
- **Anything else** — grab Justin's team with a screenshot; the page's error
  messages say exactly what upstream reported.

## What this page deliberately doesn't do (yet)

- **Editing sequences, schedules, or sender emails** — that deep work lives
  in EmailBison; the New campaign button hands you a Draft to finish there.
- **Replying to prospects** — the Master Inbox is read-only; answer in
  EmailBison.
- **Pushing Monday-backed lists** — only CSV-uploaded contact lists can be
  pushed today. If a Monday-backed push would save you real time, say so.
- **Stopping or archiving campaigns** — pause/resume is the extent of send
  control here; anything stronger happens in EmailBison.

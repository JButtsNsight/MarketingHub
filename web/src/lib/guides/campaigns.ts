import type { GuideModule } from "./types";

/**
 * OWNER: campaigns domain — SMS campaigns (list, create, detail, schedule, contact lists).
 * Ids: `campaigns.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const campaigns: GuideModule = {
  // ── /campaigns (the list) ──
  "campaigns.list.title": {
    title: "SMS text campaigns",
    body: "A campaign is one text message sent to a list of phone numbers at a scheduled time. This page shows every campaign with its status and delivery counts.",
  },
  "campaigns.list.schedule-link": {
    title: "The send calendar",
    body: "Opens the blast schedule — upcoming and in-progress campaigns grouped by send day, so you can see what goes out when.",
  },
  "campaigns.list.lists-link": {
    title: "Saved audiences",
    body: "Opens contact lists — the saved sets of phone numbers (uploaded spreadsheets or linked Monday.com boards) that campaigns send to.",
  },
  "campaigns.list.new-link": {
    title: "Start a campaign",
    body: "Opens the builder: pick a message template, a contact list, and a weekday send slot. Nothing is sent until the scheduled slot arrives.",
  },
  "campaigns.list.table": {
    title: "All campaigns",
    body: "One row per campaign, newest first. The counts show how each send went — audience size, sent, delivered, and failed — and the send column shows its slot and time zone.",
  },
  "campaigns.list.open-campaign": {
    title: "Open this campaign",
    body: "Shows the campaign's detail page: live per-number delivery statuses, replies and click tracking, plus the pause, cancel, and reschedule controls.",
  },

  // ── /campaigns/[id] (detail) ──
  "campaigns.detail.title": {
    title: "One campaign's live view",
    body: "Everything about this send: its status, schedule, audience, and how each phone number fared. It refreshes live while sending is under way.",
  },
  "campaigns.detail.list-link": {
    title: "The audience it used",
    body: "Opens the contact list this campaign was built from. Recipients were copied at creation time, so editing the list later never changes this campaign.",
  },
  "campaigns.detail.status-cards": {
    title: "Recipient status counts",
    body: "How the audience stands right now: waiting, sent, delivered, failed, ambiguous (may or may not have sent — needs review), suppressed (opted out), and skipped (unusable numbers).",
  },
  "campaigns.detail.engagement-cards": {
    title: "What happened after",
    body: "Post-send signals: how many people tapped a tracked link, the click-through rate, replies, and STOP opt-outs triggered by this campaign.",
  },
  "campaigns.detail.replies-table": {
    title: "Replies to this send",
    body: "Texts people sent back after this campaign, newest first. The full two-way inbox lives under Engage → Inbox.",
  },
  "campaigns.detail.recipients-table": {
    title: "The outbox, row by row",
    body: "One row per phone number with its delivery status, attempts, and last error — the audit trail of the send. Ambiguous rows also get Retry / Mark failed controls.",
  },
  "campaigns.detail.retry": {
    title: "Retry an ambiguous send",
    body: "Re-queues this recipient to send now. Ambiguous means the first attempt may or may not have reached them — retrying can text this person twice, so be sure first.",
  },
  "campaigns.detail.mark-failed": {
    title: "Close as failed",
    body: "Declares this ambiguous send permanently failed: this campaign will never text the person again. Use it when you are confident nothing arrived.",
  },
  "campaigns.detail.pause": {
    title: "Pause sending",
    body: "Temporarily stops the campaign — no more texts go out until you resume. Messages already sent are unaffected; the rest simply wait.",
  },
  "campaigns.detail.resume": {
    title: "Resume sending",
    body: "Picks a paused campaign back up: the recipients still waiting go out again, continuing from where sending stopped.",
  },
  "campaigns.detail.cancel": {
    title: "Cancel — cannot be undone",
    body: "Permanently ends this campaign: recipients not yet texted will never be texted, and there is no undo. A message already in flight may still be delivered.",
  },
  "campaigns.detail.reschedule": {
    title: "Move the send slot",
    body: "Changes when this campaign goes out — a new weekday and 30-minute slot. Only possible before sending starts; recipients with their own time zone are recomputed too.",
  },
  "campaigns.detail.reschedule-date": {
    title: "New send date",
    body: "The weekday the campaign should go out instead. Blasts only send Monday through Friday.",
  },
  "campaigns.detail.reschedule-zone": {
    title: "Fallback time zone",
    body: "Used for contacts that don't carry their own time zone. Contacts with a saved zone get the send slot in their local time instead.",
  },
  "campaigns.detail.reschedule-time": {
    title: "New send slot",
    body: "The 30-minute window when sending starts — between 8:00 AM and 1:00 PM in each recipient's zone, keeping texts inside daytime hours.",
  },
  "campaigns.detail.reschedule-save": {
    title: "Apply the new schedule",
    body: "Moves every unsent recipient to the new date and slot. If the campaign started sending in the meantime, nothing moves and the page shows the real state.",
  },
  "campaigns.detail.reschedule-cancel": {
    title: "Close without changes",
    body: "Closes this editor and keeps the current schedule. It does not cancel the campaign itself.",
  },

  // ── /campaigns/new (builder) ──
  "campaigns.new.title": {
    title: "Build a text campaign",
    body: "A campaign pairs a message template with a contact list and a send slot. Submitting this form schedules the blast — nothing is sent until the slot arrives.",
  },
  "campaigns.new.create-list-link": {
    title: "Make an audience first",
    body: "A campaign needs a contact list — a saved set of phone numbers. This opens the list builder, where you upload a spreadsheet or link a Monday.com board.",
  },
  "campaigns.new.name": {
    title: "Name this campaign",
    body: "A label for your team only — recipients never see it. Pick something you'll recognize in the campaign list later.",
  },
  "campaigns.new.template": {
    title: "The message to send",
    body: "A template is a pre-written text message, managed under Templates. Picking one previews its exact wording; {{name}} and {{firstName}} are filled in per contact.",
  },
  "campaigns.new.contact-list": {
    title: "Who receives it",
    body: "A contact list is a saved audience — phone numbers from an uploaded spreadsheet or a linked Monday.com board. Monday lists pull their members live when you create the campaign.",
  },
  "campaigns.new.send-date": {
    title: "The day it sends",
    body: "Blasts go out on weekdays only (Monday–Friday) and the date can't be in the past.",
  },
  "campaigns.new.timezone": {
    title: "Fallback time zone",
    body: "Used for contacts without their own time zone. Contacts that carry one (from the sheet or a Monday column) get the send slot in their local time instead.",
  },
  "campaigns.new.send-time": {
    title: "The 30-minute send slot",
    body: "Sending starts inside this window — slots run 8:00 AM to 1:00 PM in each recipient's zone, keeping texts inside polite daytime hours.",
  },
  "campaigns.new.create": {
    title: "Schedule the blast",
    body: "Creates the campaign and books every recipient into the chosen slot. Nothing is texted right now — you can still pause, reschedule, or cancel before it sends.",
  },

  // ── /campaigns/schedule (calendar) ──
  "campaigns.schedule.title": {
    title: "The send calendar",
    body: "Every campaign still holding a send slot — scheduled, paused, or actively sending — grouped by day. Finished and canceled campaigns drop off this view.",
  },
  "campaigns.schedule.campaigns-link": {
    title: "All campaigns",
    body: "Back to the full campaign list, including the completed and canceled ones that no longer appear on this calendar.",
  },
  "campaigns.schedule.new-link": {
    title: "Start a campaign",
    body: "Opens the builder: pick a message template, a contact list, and a weekday send slot. The new campaign then appears here on its send day.",
  },
  "campaigns.schedule.day": {
    title: "One send day",
    body: "Every campaign holding a slot on this day, in send order, with how many of its texts are still waiting to go out.",
  },
  "campaigns.schedule.open-campaign": {
    title: "Open this campaign",
    body: "Shows the campaign's detail page, where you can watch delivery live and pause, resume, cancel, or reschedule it.",
  },

  // ── /campaigns/lists (contact lists) ──
  "campaigns.lists.title": {
    title: "Saved audiences",
    body: "A contact list is a saved set of phone numbers a campaign can send to — from an uploaded spreadsheet or a linked Monday.com board. This page shows every one.",
  },
  "campaigns.lists.campaigns-link": {
    title: "Back to campaigns",
    body: "Returns to the campaign list — the sends built on top of these audiences.",
  },
  "campaigns.lists.new-link": {
    title: "Add an audience",
    body: "Opens the list builder: upload a spreadsheet of contacts or link a Monday.com board whose members become the recipients.",
  },
  "campaigns.lists.table": {
    title: "All contact lists",
    body: "One row per saved audience with its source. Uploaded sheets show a fixed contact count; Monday boards show “live” because membership is whatever the board holds when a campaign is created.",
  },
  "campaigns.lists.open-list": {
    title: "Open this list",
    body: "Shows the list's details — for uploaded sheets, every parsed row and whether its number is usable; for Monday boards, the saved board settings.",
  },

  // ── /campaigns/lists/[id] (list detail) ──
  "campaigns.list-detail.title": {
    title: "One saved audience",
    body: "Where this contact list came from and what's in it. The campaign builder picks its recipients from lists like this one.",
  },
  "campaigns.list-detail.all-lists-link": {
    title: "All contact lists",
    body: "Back to the full set of saved audiences.",
  },
  "campaigns.list-detail.delete": {
    title: "Delete this list",
    body: "Asks once to confirm, then permanently removes this audience and its stored rows — there is no undo. Lists a campaign was built from are protected: the delete is refused.",
  },
  "campaigns.list-detail.quality-cards": {
    title: "Number quality summary",
    body: "How the uploaded sheet parsed: usable contacts, invalid rows (numbers that can't receive texts), and duplicates (only the first occurrence is kept).",
  },
  "campaigns.list-detail.members-table": {
    title: "Every parsed row",
    body: "Each row from the uploaded sheet with its cleaned phone number, its classification, and the consent info exactly as provided — audit evidence, never edited.",
  },
  "campaigns.list-detail.live-monday": {
    title: "Live board membership",
    body: "No rows are stored for a Monday-linked list. Recipients are read from the board at the moment a campaign is created, so the audience always matches the board.",
  },

  // ── /campaigns/lists/new (list builder) ──
  "campaigns.lists-new.title": {
    title: "Create a contact list",
    body: "A contact list is a saved audience for campaigns. Build one by uploading a spreadsheet of contacts or by linking a Monday.com board.",
  },
  "campaigns.lists-new.source": {
    title: "Where contacts come from",
    body: "Two sources: upload a one-time spreadsheet of phone numbers, or link a Monday.com board whose members are read live each time a campaign is created.",
  },
  "campaigns.lists-new.name": {
    title: "Name this list",
    body: "The label your team sees when picking an audience — recipients never see it. It's pre-filled from the file or board name unless you type one.",
  },
  "campaigns.lists-new.file": {
    title: "The contacts spreadsheet",
    body: "A CSV is a plain spreadsheet file (in Excel: File → Save As → CSV). It needs a header row with a phone column; name and timezone columns are used when present.",
  },
  "campaigns.lists-new.board": {
    title: "Which Monday board",
    body: "The Monday.com board holding your contacts — paste its URL or its numeric id. Requires the Monday integration to be configured in this environment.",
  },
  "campaigns.lists-new.load-board": {
    title: "Fetch board columns",
    body: "Reads the board from Monday.com so you can pick which column holds phone numbers. Nothing is saved yet — this is only a preview.",
  },
  "campaigns.lists-new.phone-column": {
    title: "The phone number column",
    body: "Tells MarketingHub which board column holds each contact's phone number. A likely column is pre-selected when one is detected.",
  },
  "campaigns.lists-new.timezone-column": {
    title: "Per-contact time zones",
    body: "Optional: a column holding each contact's time zone. Contacts with one get campaign texts in their own local slot; everyone else uses the campaign's fallback zone.",
  },
  "campaigns.lists-new.outcome-column": {
    title: "Write results to Monday",
    body: "Optional: after a campaign sends, each contact's outcome is written back into this board column. Only plain text columns work — other column types reject the write.",
  },
  "campaigns.lists-new.create": {
    title: "Save the list",
    body: "Saves this audience so campaigns can send to it. Nothing is texted — creating a list never messages anyone.",
  },
};

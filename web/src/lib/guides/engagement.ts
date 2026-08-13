import type { GuideModule } from "./types";

/**
 * OWNER: engagement domain — Templates, Inbox, Review queue, Suppressions.
 * Ids: `engagement.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const engagement: GuideModule = {
  // --- Templates: browse / search / filter ---
  "engagement.templates.heading": {
    title: "Message templates",
    body: "A template is a saved, reusable message — the text or email a campaign sends. This page lists every template so you can search, filter, and open one to preview or edit.",
  },
  "engagement.templates.upload": {
    title: "Add a template",
    body: "Opens a form to create a new template by typing the message or uploading a file. Nothing is sent to anyone — a template is just a saved draft that campaigns use later.",
  },
  "engagement.templates.search": {
    title: "Search templates",
    body: "Type to filter the list to templates whose name or content contains your words. Results update as you type; clear the box to see everything again.",
  },
  "engagement.templates.category-filter": {
    title: "Filter by category",
    body: "Categories group templates by purpose, like Promotion or Newsletter. Click one to show only that group; click it again to clear the filter.",
  },
  "engagement.templates.type-filter": {
    title: "Filter by type",
    body: "Every template is either a Text (an SMS sent to phones) or an Email. Click one to show only that kind; click it again to clear the filter.",
  },
  "engagement.templates.grid": {
    title: "Your template library",
    body: "Each card is one saved template, showing its name, category, type, tags, and creation date. Click a card's name to open it.",
  },
  "engagement.templates.card": {
    title: "Open this template",
    body: "Opens this template's own page: a preview of exactly what recipients would receive, its details, and an editor for changing it.",
  },

  // --- Templates: upload form ---
  "engagement.upload.heading": {
    title: "New template form",
    body: "Creates one reusable message for campaigns to send. Fill in the details and content, then save — the template is stored in the shared library, and nothing is sent to anyone.",
  },
  "engagement.upload.name": {
    title: "Template name",
    body: 'A short label so people can find this template later, like "Spring Promo 2026". It appears only in this console — recipients never see it.',
  },
  "engagement.upload.type": {
    title: "Text or email",
    body: "Text means an SMS sent to phones; Email means a formatted email with a subject line. Choose carefully — the type cannot be changed after saving.",
  },
  "engagement.upload.category": {
    title: "Category",
    body: "The purpose group this template belongs to, like Promotion or Newsletter. It only organizes the library, so pick the closest fit.",
  },
  "engagement.upload.subject": {
    title: "Email subject line",
    body: "The subject line recipients see in their email inbox before opening the message. Required for email templates; text templates don't have one.",
  },
  "engagement.upload.tags": {
    title: "Tags",
    body: 'Free-form keywords that help people find this template later, like "sale" or "spring". Press Enter after each tag; click a tag\'s × to remove it.',
  },
  "engagement.upload.body": {
    title: "Message content",
    body: "The message itself, exactly as recipients will get it. Text messages may include {{name}} and {{firstName}} — merge fields, placeholders replaced with each recipient's real name at send time.",
  },
  "engagement.upload.file": {
    title: "Upload a file instead",
    body: "Loads a .txt, .html, or .eml file from your computer into the Body box instead of typing. Only the file's text is kept, and you can still edit it before saving.",
  },
  "engagement.upload.save": {
    title: "Save the template",
    body: "Stores the template in the shared library and opens its page. Nothing is sent to recipients — sending only ever happens from a campaign.",
  },

  // --- Templates: single-template page ---
  "engagement.template.heading": {
    title: "One template's page",
    body: "Everything about this one saved message: a preview of what recipients get, its details, and an editor. Edits affect future sends that use this template, never messages already sent.",
  },
  "engagement.template.back": {
    title: "Back to the library",
    body: "Returns to the full template library. Leaving this page changes nothing — any unsaved edits below are simply dropped.",
  },
  "engagement.template.preview": {
    title: "Recipient's-eye preview",
    body: "Shows the message as recipients will receive it. Email HTML is rendered in a locked frame that cannot run code, so even untrusted content is safe to look at.",
  },
  "engagement.template.view-source": {
    title: "Preview or raw HTML",
    body: "Switches between the rendered email and the raw HTML code behind it. Looking never changes the template — use it to check exactly what the file contains.",
  },
  "engagement.template.details": {
    title: "Template details",
    body: "This template's record: its type, category group, tags, who created it, and when it was created and last changed. Use the Edit template button to change most of these.",
  },
  "engagement.template.edit": {
    title: "Edit this template",
    body: "Opens a form to change this template's name, category, tags, subject, or content. Nothing is stored until you press Save changes, and the type (text vs email) can never change.",
  },

  // --- Templates: inline editor ---
  "engagement.editor.name": {
    title: "Template name",
    body: "The label shown in the template library. Renaming is safe — campaigns keep working, and recipients never see this name.",
  },
  "engagement.editor.category": {
    title: "Category",
    body: "The purpose group used to organize and filter the library. Pick one of the suggestions or type a new group name.",
  },
  "engagement.editor.tags": {
    title: "Tags",
    body: "Search keywords for this template, separated by commas. They only help people find it in the library — they never appear in the message.",
  },
  "engagement.editor.subject": {
    title: "Email subject line",
    body: "The subject line recipients see in their email inbox. Required for email templates; changing it affects future sends only.",
  },
  "engagement.editor.body": {
    title: "Message content",
    body: "The message itself. In texts, {{name}} and {{firstName}} are merge fields — placeholders swapped for each recipient's real name; any other {{...}} is unsupported and blocks saving.",
  },
  "engagement.editor.cancel": {
    title: "Discard edits",
    body: "Closes the editor and throws away everything you changed in it. The saved template is untouched.",
  },
  "engagement.editor.save": {
    title: "Save changes",
    body: "Updates the stored template for everyone who uses this library. Future campaign sends pick up the new content; messages already sent never change.",
  },

  // --- Inbox: replies from recipients ---
  "engagement.inbox.heading": {
    title: "Replies from recipients",
    body: "Every text message people send back after a campaign lands here, newest first. Mark each one handled once someone has dealt with it — this page never sends anything itself.",
  },
  "engagement.inbox.filter-all": {
    title: "Show every reply",
    body: "Shows every reply, including ones already marked handled. Use it to review history or find a reply that was closed by mistake.",
  },
  "engagement.inbox.filter-unhandled": {
    title: "Show open replies only",
    body: "Narrows the list to replies no one has dealt with yet — the team's to-do list. The count in the header tracks the same number.",
  },
  "engagement.inbox.table": {
    title: "The reply list",
    body: "One row per incoming text: when it arrived, the sender's number, the message, the campaign that likely prompted it, and whether a person has handled it yet.",
  },
  "engagement.inbox.campaign-link": {
    title: "Likely source campaign",
    body: "The campaign this person is most likely replying to, matched by their phone number. Click to open that campaign; a dash means no match was found.",
  },
  "engagement.inbox.toggle-handled": {
    title: "Mark handled or reopen",
    body: "Flips whether this reply still needs attention: Mark handled when someone has dealt with it, Reopen if it was closed too soon. Nothing is texted to the sender either way.",
  },

  // --- Review queue: sends needing a human decision ---
  "engagement.review.heading": {
    title: "Sends needing a decision",
    body: "Campaign texts that stopped mid-send collect here from every campaign. Some failed outright; some are ambiguous — the system cannot tell whether the text went out, so a person must decide.",
  },
  "engagement.review.stat-ambiguous": {
    title: "Ambiguous sends",
    body: "Sends where the attempt got no clear answer, so the text may or may not have reached the person. Each one waits for a human: retry it, or mark it sent or failed in the table below.",
  },
  "engagement.review.stat-failed": {
    title: "Failed sends",
    body: "Sends that definitely did not go out, even after automatic retries. Safe to retry from the table below — the person has received nothing.",
  },
  "engagement.review.stat-undelivered": {
    title: "Undelivered sends",
    body: "Sends the phone carrier accepted but then rejected — wrong number, blocked, or similar. Retrying could text the person twice, so these rows are informational only.",
  },
  "engagement.review.table": {
    title: "The decision queue",
    body: "One row per stuck message: who it was for, what went wrong, and the resolve actions your decision allows. Undelivered rows offer no actions on purpose — retrying them risks double-texting.",
  },
  "engagement.review.campaign-link": {
    title: "Source campaign",
    body: "The campaign this stuck message belongs to. Click through for the full campaign view, where the same row can also be resolved.",
  },
  "engagement.review.retry": {
    title: "Try sending again",
    body: "Queues this message to send again right away. Use it when you believe the text never went out — if it actually did, the person will receive it twice.",
  },
  "engagement.review.mark-sent": {
    title: "Record it as sent",
    body: "Records that the text really did reach the person — use it when you have evidence, like a reply from them. Nothing is sent; the row simply stops asking for a decision.",
  },
  "engagement.review.mark-failed": {
    title: "Record it as failed",
    body: "Closes the question by declaring the text never arrived. Nothing is sent or retried; the row leaves this queue and counts as a failure in the campaign's results.",
  },

  // --- Suppressions: the do-not-text list ---
  "engagement.suppressions.heading": {
    title: "The do-not-text list",
    body: "Phone numbers that must never receive campaign texts again. People who text STOP are added automatically and permanently; staff can also block numbers by hand, and those can be removed later.",
  },
  "engagement.suppressions.add": {
    title: "Block a number manually",
    body: "Opens a short form to block a phone number by hand — say, someone who asked to stop by phone. Blocking also cancels any of their campaign texts that are queued but not yet sent.",
  },
  "engagement.suppressions.phone": {
    title: "Number to block",
    body: "The US phone number to stop texting, in any familiar format — it is tidied into one standard form automatically. One number per entry.",
  },
  "engagement.suppressions.note": {
    title: "Reason for blocking",
    body: "Why this number is being blocked. It is kept permanently in the audit record along with your name — write it for a future teammate wondering who asked and when.",
  },
  "engagement.suppressions.cancel-add": {
    title: "Close without blocking",
    body: "Closes the form without blocking anything. The number stays textable and nothing you typed is kept.",
  },
  "engagement.suppressions.confirm-add": {
    title: "Add to the list",
    body: "Blocks the number immediately: future campaigns skip it, and its queued, unsent texts are canceled. Manual entries like this can be removed later if needed.",
  },
  "engagement.suppressions.search": {
    title: "Find a number",
    body: "Type any part of a phone number — digits only are fine — and press Enter to filter the list. Clear the box and press Enter again to see everything.",
  },
  "engagement.suppressions.table": {
    title: "Who is blocked and why",
    body: "One row per blocked number: how it got here, who added it, and why. STOP means the person texted STOP — that block is permanent; manual means staff added it and it can be removed.",
  },
  "engagement.suppressions.remove": {
    title: "Unblock this number",
    body: "Starts removing this manual block so future campaigns may text the number again. A confirm step follows; STOP entries have no remove button because they can never be removed.",
  },
  "engagement.suppressions.confirm-remove": {
    title: "Really unblock it",
    body: "Permanently deletes this block — the number can be texted by future campaigns again, and the removal is written to the audit trail. Press Keep to back out.",
  },
  "engagement.suppressions.keep": {
    title: "Keep the block",
    body: "Backs out of the removal. The number stays blocked and nothing changes.",
  },
};

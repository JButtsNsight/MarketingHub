import type { GuideModule } from "./types";

/**
 * OWNER: Email Campaign Center (EmailBison). Ids: `email.center.<control>`.
 * Copy rules: plain English for someone new to EmailBison; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const email: GuideModule = {
  "email.center.connect": {
    title: "Link EmailBison",
    body: "Paste your EmailBison instance URL and an API token (Settings → Developer API in EmailBison). The token is checked live, then stored securely — campaigns appear immediately.",
  },
  "email.center.status-filter": {
    title: "Filter by status",
    body: "Narrows the table to campaigns in one state — active, paused, completed, and so on. Pick blank to see everything again.",
  },
  "email.center.table": {
    title: "Campaign dashboard",
    body: "Every EmailBison campaign with its live numbers: leads, sends, opens, replies, interested, bounces, and unsubscribes. Read-only — manage sends in EmailBison itself.",
  },
  "email.center.open": {
    title: "Open EmailBison",
    body: "Jumps to the EmailBison app in a new tab for anything this dashboard doesn't do — editing sequences, replying, or launching campaigns.",
  },
  "email.center.disconnect": {
    title: "Disconnect account",
    body: "Removes the stored API token so this console can no longer read EmailBison. Nothing in EmailBison is changed; reconnect anytime with a new token.",
  },
  "email.center.tabs": {
    title: "Campaigns or Master Inbox",
    body: "Two surfaces, named as EmailBison names them: the campaign dashboard, and the Master Inbox where every reply lands. Switching tabs never changes anything.",
  },
  "email.center.new-campaign": {
    title: "New campaign",
    body: "Creates an outbound campaign in EmailBison as a Draft — just the name. Write the sequence, schedule, and sender emails in EmailBison, then launch there.",
  },
  "email.center.pause": {
    title: "Pause sending",
    body: "Stops this campaign's sends in EmailBison right away; stats and leads stay put. Resume picks up where it left off.",
  },
  "email.center.resume": {
    title: "Resume sending",
    body: "Starts a paused campaign sending again — emails go out as soon as EmailBison picks it up, so you're asked to confirm first.",
  },
  "email.center.push": {
    title: "Push contacts",
    body: "Adds a MarketingHub contact list to this campaign as EmailBison leads. On active campaigns, new leads can take about 5 minutes to appear.",
  },
  "email.center.replies-folders": {
    title: "Inbox folders",
    body: "The Master Inbox folders, exactly as in EmailBison: Inbox, Sent, Spam, and Bounces. Unread replies show bold.",
  },
  "email.center.replies-status": {
    title: "Filter replies",
    body: "Narrows the folder to one kind of reply — interested, automated, or written by a person. Pick All replies to clear it.",
  },
  "email.center.replies-table": {
    title: "Reply list",
    body: "Every reply EmailBison received for the folder, with the campaign it came from. Read-only here — open EmailBison to answer.",
  },
};

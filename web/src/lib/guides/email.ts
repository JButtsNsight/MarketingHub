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
};

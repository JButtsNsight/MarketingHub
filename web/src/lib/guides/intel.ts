import type { GuideModule } from "./types";

/**
 * OWNER: intel domain — Competitor Intel (browse, search, sources, documents).
 * Ids: `intel.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const intel: GuideModule = {
  // --- /intel landing page ---
  "intel.home.header": {
    title: "Competitor Intel",
    body: "A private library of competitor material your team pastes in, plus a search that answers questions from it. Start here to look up what competitors say and do.",
  },

  // --- search bar + filter ---
  "intel.search.query": {
    title: "Search box",
    body: "Type a question or keywords about the stored competitor material. Nothing runs until you press Search; results are text passages pulled from the pasted documents.",
  },
  "intel.search.source-filter": {
    title: "Limit to one source",
    body: "A source is one competitor or site whose material you collected. Pick one to search only its documents, or All sources to search everything.",
  },
  "intel.search.submit": {
    title: "Run the search",
    body: "Finds matching passages right away; when the AI gateway is connected it also starts a written answer, which usually takes 10–60 seconds to appear below.",
  },
  "intel.search.stale-filter-note": {
    title: "Filter was removed",
    body: "This link filtered results to a source that has since been deleted. The filter was cleared, so your search now covers all sources instead of silently matching nothing.",
  },
  "intel.search.filter-fallback": {
    title: "Hidden filter warning",
    body: "Your results are limited to one source, but the source list failed to load, so its name can't be shown. Clear filter searches everything again.",
  },
  "intel.search.keyword-only-note": {
    title: "No AI answer here",
    body: "The AI service that writes answers isn't configured in this environment. You still get passages ranked by keyword match — there's just no summary on top.",
  },

  // --- synthesized answer panel ---
  "intel.search.answer": {
    title: "AI-written answer",
    body: "Claude, an AI model, reads the passages below and writes a short answer citing them by number. Treat it as a lead, not a fact — check the cited passages.",
  },
  "intel.search.answer-failed": {
    title: "Answer failed",
    body: "The AI task returned nothing usable, so no summary appears. The keyword-matched passages below are unaffected and still trustworthy.",
  },
  "intel.search.answer-timeout": {
    title: "Answer timed out",
    body: "No answer arrived before the 90-second cutoff, so the page stopped waiting. The passages below still stand; an immediate retry may reattach to the same stalled task.",
  },
  "intel.search.citation": {
    title: "Cited passage",
    body: "The [n] number names the exact passage the AI read when making that claim. Click to open the full document the passage came from.",
  },

  // --- results list ---
  "intel.search.results": {
    title: "Matching passages",
    body: "Each card is one passage — a short chunk cut from a stored document — that matched your search. Its [n] number is fixed and matches the answer's citations.",
  },
  "intel.search.ranked-by-claude": {
    title: "Order chosen by AI",
    body: "The AI reordered these passages by how relevant it judged them to your question. Passage numbers don't change — only the display order does.",
  },
  "intel.search.keyword-rank": {
    title: "Order by keyword match",
    body: "Passages are ordered by how strongly their words match your search terms, scored by the database. No AI judgment was involved in this ordering.",
  },
  "intel.search.result-doc-link": {
    title: "Open the document",
    body: "Opens the full stored document this passage was cut from, so you can read the surrounding context.",
  },

  // --- sources list ---
  "intel.sources.new": {
    title: "Add a source",
    body: "A source is one competitor, site, or feed you're tracking. Create one first, then paste documents into it to make them searchable.",
  },
  "intel.sources.table": {
    title: "Your sources",
    body: "Each row is a source — a named bucket for one competitor's material — with how many documents and searchable passages (chunks) it holds.",
  },
  "intel.sources.name-link": {
    title: "Open this source",
    body: "Opens the source's page: its details, every document inside it, and the form for pasting new material.",
  },
  "intel.sources.edit": {
    title: "Edit source details",
    body: "Opens a form to change this source's name, kind, URL, or notes. The documents inside it are untouched.",
  },
  "intel.sources.delete": {
    title: "Delete this source",
    body: "Permanently removes the source and every document and searchable passage inside it — they vanish from search results too. Click once to arm, again to confirm.",
  },

  // --- source create/edit form ---
  "intel.source-form.name": {
    title: "Source name",
    body: "The label this source shows in lists and the search filter. Pick something a teammate would recognize, like the competitor and page.",
  },
  "intel.source-form.kind": {
    title: "Source kind",
    body: "Where this material originates: text means pasted content, url means it tracks a web page. Either way, only text pasted in by hand is searchable today.",
  },
  "intel.source-form.url": {
    title: "URL is a bookmark",
    body: "Stores the web address for reference only — the app never fetches the page, so its content isn't searchable until someone pastes it in by hand.",
  },
  "intel.source-form.notes": {
    title: "Notes for teammates",
    body: "Free-form context about this source, shown on its page. Notes aren't part of the searchable text — only pasted documents are searched.",
  },
  "intel.source-form.cancel": {
    title: "Discard this form",
    body: "Closes the form without saving; anything you typed here is thrown away. Existing sources are not affected.",
  },
  "intel.source-form.save": {
    title: "Save the source",
    body: "Checks the fields, then creates the source or saves your edits. A new source starts empty — paste documents into it to make them searchable.",
  },

  // --- paste-a-document form ---
  "intel.add-doc.open": {
    title: "Paste a document",
    body: "Opens a form to paste competitor text — a pricing page, a changelog, an email. Pasting is the only way in today; web pages are never fetched automatically.",
  },
  "intel.add-doc.title": {
    title: "Document title",
    body: "How this document is listed and cited in search results. Say what it is and when you grabbed it, like a date-stamped snapshot.",
  },
  "intel.add-doc.content": {
    title: "The text to store",
    body: "Paste the competitor text here. It gets split into short passages (chunks) that search matches against, so headings and paragraphs are worth keeping.",
  },
  "intel.add-doc.cancel": {
    title: "Discard the paste",
    body: "Closes the form and throws away the title and text you typed. Nothing is stored.",
  },
  "intel.add-doc.submit": {
    title: "Store the document",
    body: "Saves the text and queues it for indexing. It shows as pending until a background worker processes it — usually under a minute — then it turns up in search.",
  },

  // --- one source's page ---
  "intel.source.header": {
    title: "One source's page",
    body: "Everything about a single source: its details, every document pasted into it, and the form for adding more. Use it to manage one competitor's material.",
  },
  "intel.source.url-note": {
    title: "Web fetch not built",
    body: "This source points at a web page, but the app never downloads it — search only covers text someone pasted in by hand. Automatic fetching awaits security guardrails.",
  },
  "intel.source.documents-table": {
    title: "Documents in this source",
    body: "Each row is one pasted document with its indexing status and how many searchable passages (chunks) it has produced so far.",
  },

  // --- document lifecycle (shared across source + document pages) ---
  "intel.documents.refresh": {
    title: "Refresh from server",
    body: "Reloads this page's data to pick up progress — useful while a document is still pending, since the background worker runs about every 30 seconds.",
  },
  "intel.documents.pending-note": {
    title: "Still being indexed",
    body: "A background worker is still splitting and indexing this text; until it finishes, it won't appear in search results. Refresh to check progress.",
  },
  "intel.documents.doc-link": {
    title: "Open the document",
    body: "Opens the document's own page: its full pasted text plus indexing progress and any errors.",
  },
  "intel.documents.status": {
    title: "Indexing status",
    body: "Where this document is in processing: pending or processing means the worker isn't done, embedded means it's fully searchable, error means indexing failed.",
  },
  "intel.documents.delete": {
    title: "Delete this document",
    body: "Permanently removes the document and its searchable passages — it stops appearing in search immediately. Click once to arm, again to confirm.",
  },
  "intel.documents.chunks": {
    title: "Passage count",
    body: "Documents are cut into short passages (chunks) for search; this shows how many are indexed so far. 'Not reported' means the progress check failed, not that work stopped.",
  },
  "intel.documents.embed-error": {
    title: "Indexing failed",
    body: "The worker that indexes documents hit an error, shown here word-for-word. The text is still stored, but it won't appear in search until indexing succeeds.",
  },

  // --- one document's page ---
  "intel.document.header": {
    title: "One document's page",
    body: "A single pasted document: its indexing status, how many searchable passages it produced, and the full original text below.",
  },
  "intel.document.source-link": {
    title: "Back to its source",
    body: "Opens the source this document belongs to — the bucket listing every sibling document from the same competitor.",
  },
  "intel.document.content": {
    title: "The stored text",
    body: "The exact text that was pasted in, unchanged. Search results quote passages cut from this text.",
  },

  // --- embedding provider badge (shared) ---
  "intel.provider.stub": {
    title: "Stand-in AI indexing",
    body: "Documents were indexed with a stand-in method instead of a real AI model, so any similarity ranking is illustrative only. Keyword search still works normally.",
  },
  "intel.provider.bedrock": {
    title: "Real AI indexing on",
    body: "Documents are indexed with a real AI embedding model — a numeric fingerprint of meaning — hosted on AWS Bedrock. The badge's tooltip names the exact model.",
  },
  "intel.provider.invalid": {
    title: "Indexing misconfigured",
    body: "The environment names an embedding provider that doesn't exist, so documents can't be indexed and search is unavailable until an operator fixes the setting.",
  },

  // --- shared honest states ---
  "intel.states.not-provisioned": {
    title: "Not set up here",
    body: "This environment's database is missing the tables Competitor Intel needs, so there is nothing to show. An operator must apply the schema migration first.",
  },
  "intel.states.degraded": {
    title: "Request failed",
    body: "The server reported an error for this page's data; the exact message is shown as-is. Retry sends the same request again.",
  },
  "intel.states.retry": {
    title: "Try the request again",
    body: "Sends the same request to the server once more. Useful after a brief outage; if it keeps failing, the error message above is the clue.",
  },
};

/** One guided-mode popover: a short title and 1–2 plain-English sentences. */
export interface GuideEntry {
  /** ≤ 5 words / ≤ 40 chars — the concept's name in plain language. */
  title: string;
  /** 1–2 sentences, ≤ 240 chars: what it does and when you'd use it. */
  body: string;
}

/** A domain's guide entries, keyed `<domain>.<surface>.<control>`. */
export type GuideModule = Record<string, GuideEntry>;

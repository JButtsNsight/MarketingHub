import type { ReactNode } from "react";

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** Render the value in the mono face — for IDs, URLs, timestamps, counts. */
  mono?: boolean;
}

/**
 * A definition list rendered as aligned label / value rows. Labels are the
 * uppercase micro-label treatment; values default to the UI face (or mono).
 */
export function KeyValue({ items }: { items: KeyValueItem[] }) {
  return (
    <dl className="kv">
      {items.map((it) => (
        <div className="kv-row" key={it.label}>
          <dt>{it.label}</dt>
          <dd className={it.mono ? "mono" : undefined}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default KeyValue;

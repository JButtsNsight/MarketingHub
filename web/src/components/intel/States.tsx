"use client";

// Honest shared states for the competitor-intel surfaces: schema not
// provisioned, a degraded API/error state (with retry), and a loading shim.
// These render the truth — never placeholder data.

import { Surface } from "../Surface";
import type { IntelApiError } from "./api";
import { NOT_PROVISIONED_BODY, NOT_PROVISIONED_TITLE } from "./status";

export function NotProvisionedState() {
  return (
    <Surface className="empty-state" glint>
      <h2>{NOT_PROVISIONED_TITLE}</h2>
      <p>{NOT_PROVISIONED_BODY}</p>
    </Surface>
  );
}

export function DegradedState({
  error,
  onRetry,
}: {
  error: IntelApiError;
  onRetry?: () => void;
}) {
  return (
    <Surface className="empty-state" glint>
      <h2>Something went wrong</h2>
      <p className="form-error" role="alert">
        {error.message}
      </p>
      {onRetry ? (
        <button type="button" className="type-chip" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </Surface>
  );
}

export function LoadingState({ label }: { label: string }) {
  return <p className="muted">{label}</p>;
}

/** Route an IntelApiError to the matching honest state. */
export function ErrorState({
  error,
  onRetry,
}: {
  error: IntelApiError;
  onRetry?: () => void;
}) {
  if (error.kind === "not-provisioned") return <NotProvisionedState />;
  return <DegradedState error={error} onRetry={onRetry} />;
}

// Polish run P-A (2026-08-26): inline fetch-failure caption with a retry
// affordance — the antidote to pages collapsing failed loads into silent
// "—" placeholders or blank cells. `onRetry` re-invokes the same fetch that
// failed (a bump counter, a refresh callback, whatever the page owns).

interface InlineErrorProps {
  message: string;
  onRetry: () => void;
  /** Overrides the default "retry" label when a more specific verb fits. */
  retryLabel?: string;
}

export function InlineError({ message, onRetry, retryLabel = "retry" }: InlineErrorProps) {
  return (
    <div className="error error-with-retry" role="alert">
      <span>{message}</span>
      <button type="button" className="action" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}
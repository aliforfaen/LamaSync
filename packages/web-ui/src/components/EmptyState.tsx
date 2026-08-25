// LAMA-271: shared "empty state that teaches" — replaces bare tables with a
// mini-wizard: a CSS-drawn glyph (no emoji, no image assets), a title, a
// one-sentence "how", a single primary CTA, and an optional 3-step hint.
//
// CTAs must open EXISTING flows: an in-page flow via `onCta` (new-folder
// form, add-device guide, upload) or a route via `ctaTo` (router push —
// deep-link safe). The glyph is pure CSS on the design tokens and honours
// `prefers-reduced-motion`; the component is generic on purpose so LAMA-272
// can reuse it for the device-card grid.

import { Link } from "react-router-dom";

export type EmptyStateVariant =
  | "devices"
  | "folders"
  | "storage"
  | "activity"
  | "data";

interface EmptyStateProps {
  title: string;
  /** One-sentence "how" line — glossary-clean, action-oriented. */
  how: string;
  /** Label for the single primary CTA. */
  ctaLabel: string;
  /** Opens an existing in-page flow (new-folder form, setup guide, upload…). */
  onCta?: () => void;
  /** Alternative to `onCta`: navigation to an existing route. */
  ctaTo?: string;
  /** Optional 3-step hint, rendered as a light numbered list. */
  steps?: string[];
  /** Small meta-note beside the steps, e.g. "takes 30s". */
  timeNote?: string;
  /** Picks the accent tint from the existing semantic tokens. */
  variant?: EmptyStateVariant;
}

export function EmptyState({
  title,
  how,
  ctaLabel,
  onCta,
  ctaTo,
  steps,
  timeNote,
  variant = "devices",
}: EmptyStateProps) {
  const cta =
    onCta !== undefined ? (
      <button type="button" className="action primary" onClick={onCta}>
        {ctaLabel}
      </button>
    ) : ctaTo !== undefined ? (
      <Link className="action primary" to={ctaTo}>
        {ctaLabel}
      </Link>
    ) : null;

  return (
    <section className={`estate estate--${variant}`}>
      <div className="estate-glyph" aria-hidden="true">
        <span className="estate-orbit" />
        <span className="estate-core" />
        <span className="estate-node" />
      </div>
      <h3 className="estate-title">{title}</h3>
      <p className="estate-how">{how}</p>
      {steps && steps.length > 0 ? (
        <ol className="estate-steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {timeNote ? <span className="estate-time">{timeNote}</span> : null}
      {cta}
    </section>
  );
}
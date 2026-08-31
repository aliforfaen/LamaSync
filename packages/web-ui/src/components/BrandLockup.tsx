import darkMossMark from "../assets/brand/lama-pack-dark-moss.png";
import lightTealMark from "../assets/brand/lama-pack-light-teal.png";

/**
 * The shared LamaSync masthead treatment. The generated pack mark stays
 * decorative while the product name remains live text for accessibility,
 * responsive layout, and future localization.
 */
export function BrandLockup({ className = "" }: { className?: string }) {
  const classes = ["brand-lockup", className].filter(Boolean).join(" ");

  return (
    <span className={classes}>
      <span className="brand-mark" aria-hidden="true">
        <img
          className="brand-mark-image brand-mark-image--dark"
          src={darkMossMark}
          alt=""
        />
        <img
          className="brand-mark-image brand-mark-image--light"
          src={lightTealMark}
          alt=""
        />
      </span>
      <span className="brand-name">
        Lama<span className="brand-accent">Sync</span>
      </span>
    </span>
  );
}

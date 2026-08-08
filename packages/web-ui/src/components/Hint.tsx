// Workstream 2: the two shared hint primitives. `<Hint>` renders an inline
// `?` badge with a `title` tooltip; `<HintText>` renders a `.muted` line
// under a form label (the implicit pattern the app already used). All copy
// comes from `concepts.ts`.

import type { ReactNode } from "react";

export function Hint({ text }: { text: string }) {
  return (
    <span className="hint-badge" title={text} aria-label={text} role="img">
      ?
    </span>
  );
}

export function HintText({ children }: { children: ReactNode }) {
  return <span className="muted">{children}</span>;
}

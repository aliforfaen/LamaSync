/**
 * LAMA-275 page-context treatment: every page opens with a title and one
 * sentence of purpose so the view answers "where am I, what does this do"
 * before showing controls. Purely presentational — no data fetching.
 */
interface PageHeaderProps {
  title: string;
  purpose: string;
}

export function PageHeader({ title, purpose }: PageHeaderProps) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p className="page-purpose">{purpose}</p>
    </header>
  );
}

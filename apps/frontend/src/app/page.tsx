import type { JSX } from "react";

// App shell only, Sprint 1 (IMPLEMENTATION_PLAN.md). Real screens — Restaurant Portal, Waiter
// Portal — arrive with their owning modules (UX_MAP.md), starting Sprint 3.
export default function HomePage(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="text-small text-muted">Hospitality Operating System — Sprint 1 foundation.</p>
    </main>
  );
}

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type JSX, type ReactNode } from "react";

// One QueryClient per browser session, not per render — created lazily inside useState so it
// survives re-renders but isn't shared across requests on the server (Next.js App Router
// convention for client-side state providers).
export function Providers({ children }: { children: ReactNode }): JSX.Element {
  const [queryClient] = useState(() => new QueryClient());

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

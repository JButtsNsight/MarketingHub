import type { ReactNode } from "react";
// Fonts bundled locally via @fontsource (the CDN is blocked on the network).
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
// Geist Sans — the one UI + display family across BOTH themes (replaced the
// Marcellus/DM Sans light stack; hierarchy differentiates via weight/size).
import "@fontsource/marcellus/400.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "../styles/globals.css";
import { DEFAULT_THEME } from "@/lib/theme";

export const metadata = {
  title: "MarketingHub Console",
  description:
    "Console for the MarketingHub self-hosted Supabase-on-AWS backend.",
};

// Restore the persisted theme before first paint to avoid a flash.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('mh-theme');document.documentElement.dataset.theme=(t==='light'||t==='dark')?t:'${DEFAULT_THEME}';}catch(_){document.documentElement.dataset.theme='${DEFAULT_THEME}';}})();`;

/**
 * Root layout: the document shell only. The authenticated app chrome lives in
 * the (app) route group's layout; the (auth) login route renders bare here.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint themeBootstrap script mutates
    // data-theme from localStorage, so a returning non-default user's
    // <html> attribute intentionally differs from the server-rendered default.
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

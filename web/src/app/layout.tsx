import type { ReactNode } from "react";
// Fonts bundled locally via @fontsource (the CDN is blocked on the network).
import "@fontsource/marcellus/400.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../styles/globals.css";
import { DEFAULT_SKIN, DEFAULT_THEME } from "@/lib/theme";

export const metadata = {
  title: "MarketingHub Console",
  description:
    "Console for the MarketingHub self-hosted Supabase-on-AWS backend.",
};

// Restore the persisted theme/skin before first paint to avoid a flash.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('mh-theme');var s=localStorage.getItem('mh-skin');var e=document.documentElement;e.dataset.theme=(t==='light'||t==='dark')?t:'${DEFAULT_THEME}';e.dataset.skin=(s==='glass'||s==='flat')?s:'${DEFAULT_SKIN}';}catch(_){document.documentElement.dataset.theme='${DEFAULT_THEME}';document.documentElement.dataset.skin='${DEFAULT_SKIN}';}})();`;

/**
 * Root layout: the document shell only. The authenticated app chrome lives in
 * the (app) route group's layout; the (auth) login route renders bare here.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint themeBootstrap script mutates
    // data-theme/data-skin from localStorage, so a returning non-default user's
    // <html> attributes intentionally differ from the server-rendered defaults.
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      data-skin={DEFAULT_SKIN}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

import type { ReactNode } from "react";
// Fonts bundled locally via @fontsource (the CDN is blocked on the network).
import "@fontsource/marcellus/400.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../styles/globals.css";
import { AppShell } from "@/components/AppShell";
import { DEFAULT_SKIN, DEFAULT_THEME } from "@/lib/theme";

export const metadata = {
  title: "MarketingHub",
  description: "Campaign templates for NSight marketing.",
};

// Restore the persisted theme/skin before first paint to avoid a flash.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('mh-theme');var s=localStorage.getItem('mh-skin');var e=document.documentElement;e.dataset.theme=(t==='light'||t==='dark')?t:'${DEFAULT_THEME}';e.dataset.skin=(s==='glass'||s==='flat')?s:'${DEFAULT_SKIN}';}catch(_){document.documentElement.dataset.theme='${DEFAULT_THEME}';document.documentElement.dataset.skin='${DEFAULT_SKIN}';}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={DEFAULT_THEME} data-skin={DEFAULT_SKIN}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

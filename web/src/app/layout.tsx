import type { ReactNode } from "react";

export const metadata = {
  title: "MarketingHub",
  description: "Campaign templates for NSight marketing.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

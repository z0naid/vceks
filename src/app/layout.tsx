import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "securly-tool-template",
  description: "A private tool behind an ALB with OpenID Connect authentication",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

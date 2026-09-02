import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "知微",
  description: "见微，知著。一个会在长期交流中慢慢懂你的 AI 陪伴应用。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}


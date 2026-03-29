import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wealth Tracker | 资产总览",
  description: "流水驱动的本地资产追踪",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /* suppressHydrationWarning：部分浏览器扩展会向 body 注入属性（如 cz-shortcut-listen），避免误报 hydration 不一致 */
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased min-h-screen" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}

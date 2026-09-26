import type { Metadata } from "next";
import { Toaster } from "sonner";
import "@fontsource-variable/inter";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "EasyETL — Connect Anything. Modernize Automatically. Deploy to Databricks.",
  description: "No-code, AI-powered data integration and modernization platform for Databricks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster position="top-right" offset={76} richColors closeButton toastOptions={{ className: "!rounded-xl" }} />
      </body>
    </html>
  );
}

import "./globals.css";

export const metadata = {
  title: "PromptBuddy",
  description: "Optimize prompts for token efficiency and clarity",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

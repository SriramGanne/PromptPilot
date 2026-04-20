import "./globals.css";

const SITE_TITLE       = "PromptPilot | Expert AI Prompting";
const SITE_DESCRIPTION =
  "Turn plain-language intent into production-ready prompts. PromptPilot grounds every prompt in peer-reviewed research so non-technical professionals get expert-quality LLM output — no prompt engineering required.";

export const metadata = {
  // `template` lets child routes override just their own title while keeping
  // the "| PromptPilot" suffix for consistency in browser tabs and SERPs.
  title: { default: SITE_TITLE, template: "%s | PromptPilot" },
  description: SITE_DESCRIPTION,
  applicationName: "PromptPilot",
  keywords: [
    "prompt engineering",
    "AI prompts",
    "ChatGPT prompts",
    "Claude prompts",
    "Gemini prompts",
    "LLM prompting",
    "RAG",
    "prompt optimizer",
  ],
  authors: [{ name: "PromptPilot" }],
  // Open Graph — used by LinkedIn, Facebook, Slack, Discord, iMessage, etc.
  openGraph: {
    type: "website",
    siteName: "PromptPilot",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  // Twitter/X — summary_large_image renders the big hero card in timelines.
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

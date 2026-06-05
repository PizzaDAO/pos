import type { Metadata } from "next";
import { TerminalClient } from "./components/terminal-client";

export const metadata: Metadata = {
  title: "Terminal — Pizzeria POS",
  description: "Offline-first counter POS terminal.",
};

export default function TerminalPage() {
  return <TerminalClient />;
}

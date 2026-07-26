/**
 * /admin — the role-gated dashboard (spec M9).
 *
 * The layout itself is a Server Component so it can own the metadata, but it
 * renders nothing of its own: <AdminGate> decides whether any child mounts.
 * Every page below is a Client Component that reads through the visitor's
 * own session, so passing them as children costs nothing on the server — no
 * admin data is fetched until the gate has passed on the client.
 */
import type { Metadata } from "next";
import { AdminGate } from "./admin-gate";

export const metadata: Metadata = {
  title: "Admin — VOUCH",
  // Nothing here should ever surface in a search result.
  robots: { index: false, follow: false },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminGate>{children}</AdminGate>;
}

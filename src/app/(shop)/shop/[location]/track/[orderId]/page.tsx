/**
 * Customer order-tracking page (Phase 4). Live status via the realtime polling
 * seam, including delivery driver/ETA. Server component passes the order id down
 * to the polling client. No env vars required.
 */
import type { Metadata } from "next";
import { TrackClient } from "./track-client";

export const metadata: Metadata = {
  title: "Track your order",
  description: "Live status of your pizza order.",
  robots: { index: false, follow: false },
};

export default async function TrackPage({
  params,
}: {
  params: Promise<{ location: string; orderId: string }>;
}) {
  const { location, orderId } = await params;
  return <TrackClient slug={location} orderId={orderId} />;
}

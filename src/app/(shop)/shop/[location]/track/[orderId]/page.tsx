/**
 * Customer order-tracking page (Phase 4). Live status via the realtime polling
 * seam, including delivery driver/ETA. Server component passes the order id down
 * to the polling client. No env vars required.
 */
import { TrackClient } from "./track-client";

export default async function TrackPage({
  params,
}: {
  params: Promise<{ location: string; orderId: string }>;
}) {
  const { location, orderId } = await params;
  return <TrackClient slug={location} orderId={orderId} />;
}

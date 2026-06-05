import { KitchenBoard } from "./components/kitchen-board";

/**
 * Kitchen Display System (Phase 3). Realtime ticket board for the demo
 * location, fed via the polling realtime abstraction (Supabase Realtime
 * deferred). Bump/recall, station routing, and age coloring live in the client
 * board component.
 */
export default function KitchenPage() {
  return <KitchenBoard />;
}

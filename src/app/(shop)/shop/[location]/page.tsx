import { SurfacePlaceholder } from "@/components/surface-placeholder";

export default async function ShopPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  return (
    <SurfacePlaceholder
      surface="Shop"
      description={`Customer online ordering storefront for location "${location}". Browse, build, cart, checkout, pickup/delivery, and tracking land in Phase 4.`}
    />
  );
}

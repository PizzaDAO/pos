import { TrainingBanner } from "@/components/training-banner";

export default function KitchenGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TrainingBanner />
      {children}
    </>
  );
}

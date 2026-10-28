import { TrainingBanner } from "@/components/training-banner";

export default function AdminGroupLayout({
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

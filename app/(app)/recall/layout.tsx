import { RecallTabs } from "./recall-tabs";

export default function RecallLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <RecallTabs />
      {children}
    </div>
  );
}

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ChartCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function EmptyChart({ children = "No data for this period." }: { children?: React.ReactNode }) {
  return <p className="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed text-sm">{children}</p>;
}

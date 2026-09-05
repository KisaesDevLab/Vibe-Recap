import { Card, PageTitle } from "../ui";

export function DashboardPage() {
  return (
    <>
      <PageTitle>Dashboard</PageTitle>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Processing">
          <p className="text-sm text-slate-500">No jobs yet.</p>
        </Card>
        <Card title="Needs review">
          <p className="text-sm text-slate-500">Nothing waiting.</p>
        </Card>
        <Card title="Recent">
          <p className="text-sm text-slate-500">Upload a return to get started.</p>
        </Card>
      </div>
    </>
  );
}

import { Link } from "react-router";
import type { JobSummaryDto } from "@vibe-recap/shared";
import { Badge } from "../ui";
import { fmtDate, shortId, STATUS_LABEL, STATUS_TONE } from "../lib/format";

export function StatusBadge({ status }: { status: JobSummaryDto["status"] }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function JobTable({ jobs, empty = "No jobs.", showClient = true }: { jobs: JobSummaryDto[]; empty?: string; showClient?: boolean }) {
  if (jobs.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3">Job</th>
            {showClient && <th className="py-2 pr-3">Client</th>}
            <th className="py-2 pr-3">Year</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Step</th>
            <th className="py-2 pr-3">Updated</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">
                <Link to={`/jobs/${j.id}`} className="text-brand hover:underline">
                  {shortId(j.id)}
                </Link>
              </td>
              {showClient && (
                <td className="py-2 pr-3">
                  <Link to={`/clients/${j.clientId}`} className="hover:underline">
                    {j.clientName}
                  </Link>
                  {j.hasPrior && <span className="ml-1 text-xs text-slate-400">+prior</span>}
                </td>
              )}
              <td className="py-2 pr-3">{j.taxYear ?? ""}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={j.status} />
              </td>
              <td className="py-2 pr-3 text-slate-600">
                {j.status === "failed" ? (
                  <span className="text-red-700">
                    {j.errorStep}: {j.errorMessage}
                  </span>
                ) : (
                  j.step ?? ""
                )}
              </td>
              <td className="py-2 pr-3 text-slate-500">{fmtDate(j.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import type { ContractIssue } from "@/lib/artifact-contract";

export function ContractIssues({ issues }: { issues: ContractIssue[] }) {
  return (
    <ul className="space-y-2 text-xs">
      {issues.map((issue, index) => (
        <li
          key={`${issue.path}:${index}`}
          className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800"
        >
          <p className="font-mono font-semibold break-all">{issue.path}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">期望：{issue.expected}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">实际：{issue.actual}</p>
        </li>
      ))}
    </ul>
  );
}

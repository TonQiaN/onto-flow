import { NextResponse } from "next/server";
import { count, inArray } from "drizzle-orm";
import { db, workflowNodes, workflows } from "@/db";
import { handle } from "@/lib/http";
import "@/server/writers";
import {
  listEnvelope,
  parseListQuery,
  selectLibraryPage,
} from "@/server/writers/list";
import { respond } from "@/server/writers/types";
import { createWorkflow } from "@/server/writers/workflow";

export const dynamic = "force-dynamic";

interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  updatedAt: Date;
  nodeCount: number;
}

export async function GET(request: Request) {
  return handle(() => {
    const query = parseListQuery(request.url);
    const page = selectLibraryPage({
      kind: "workflow",
      table: workflows,
      columns: {
        id: workflows.id,
        name: workflows.name,
        description: workflows.description,
        updatedAt: workflows.updatedAt,
      },
      query,
    });

    let items: WorkflowListItem[] = [];
    if (page.ids.length > 0) {
      const nodeCounts = new Map(
        db
          .select({ workflowId: workflowNodes.workflowId, n: count() })
          .from(workflowNodes)
          .where(inArray(workflowNodes.workflowId, page.ids))
          .groupBy(workflowNodes.workflowId)
          .all()
          .map((r) => [r.workflowId, r.n]),
      );
      items = db
        .select()
        .from(workflows)
        .where(inArray(workflows.id, page.ids))
        .all()
        .map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          updatedAt: w.updatedAt,
          nodeCount: nodeCounts.get(w.id) ?? 0,
        }));
    }

    return NextResponse.json(listEnvelope(page, items));
  });
}

export async function POST(request: Request) {
  return handle(async () => respond(createWorkflow(await request.json())));
}

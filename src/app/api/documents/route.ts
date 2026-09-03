import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, purchasePlans } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    db.select().from(purchasePlans).orderBy(desc(purchasePlans.createdAt)).all(),
  );
}

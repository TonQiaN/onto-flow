import { NextResponse } from "next/server";
import { db, models } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(db.select().from(models).all());
}

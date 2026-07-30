import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getAdminSession();
  redirect(session ? "/console" : "/login");
}

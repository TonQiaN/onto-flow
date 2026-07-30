import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { normalizedBasePath } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getAdminSession();
  const basePath = normalizedBasePath();
  redirect(`${basePath}${session ? "/console" : "/login"}`);
}

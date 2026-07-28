import { redirect } from "next/navigation";
import { getSession, homeForRole } from "@/lib/auth";

export default async function Home() {
  const user = await getSession();
  redirect(user ? homeForRole(user.role) : "/login");
}

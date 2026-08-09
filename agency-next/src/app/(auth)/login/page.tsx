import { redirect } from "next/navigation";
import { Clock } from "lucide-react";
import { getSession, homeForRole } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · NVK Hub" };

/**
 * The sign-in screen: one card, centred, and nothing else.
 *
 * The pitch panel beside it was talking to someone who has already decided —
 * everyone reaching this page has an account and wants to be past it. So the
 * page is the card, given room to be read rather than squeezed into a column.
 *
 * One committed dark treatment rather than following the theme. This is seen
 * for a few seconds and is the only screen that is purely the brand's;
 * everything after it belongs to the work.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const user = await getSession();
  if (user) redirect(homeForRole(user.role));

  const expired = (await searchParams).expired === "1";

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#0d0c0f] px-6 py-12 text-white">
      {/* Warmth behind the card, so it sits in light rather than on a flat ground. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(46rem 34rem at 50% -10%, rgba(249,115,22,0.26), transparent 62%)," +
            "radial-gradient(34rem 28rem at 50% 112%, rgba(217,119,6,0.14), transparent 64%)",
        }}
      />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-orange-500 text-xl font-bold shadow-lg shadow-orange-500/25">
            N
          </span>
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight">NVK Hub</h1>
            <p className="mt-1 text-sm text-white/45">Sign in to continue</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-8 shadow-2xl backdrop-blur-sm">
          {/* Says why, rather than leaving someone to wonder whether they were
              signed out or something broke. */}
          {expired ? (
            <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Your session ended after an hour. Sign in again to carry on —
                nothing you saved has been lost.
              </span>
            </div>
          ) : null}

          {/* The shared inputs follow the app's tokens, which are light. Scoped
              overrides rather than a dark variant on the components: this is
              the only dark surface in the portal, and a variant maintained for
              one screen is a cost with no other payer. */}
          <div className="[&_input]:h-11 [&_input]:border-white/15 [&_input]:bg-white/[0.06] [&_input]:text-white [&_input]:placeholder:text-white/30 [&_label]:text-white/70 [&_button[type=submit]]:h-11">
            <LoginForm />
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-white/25">
          © {new Date().getFullYear()} NVK Hub
        </p>
      </div>
    </main>
  );
}

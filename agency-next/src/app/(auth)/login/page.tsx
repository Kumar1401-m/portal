import { redirect } from "next/navigation";
import { Clock } from "lucide-react";
import { getSession, homeForRole } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · NVK Hub" };

/**
 * The sign-in screen.
 *
 * Deliberately one dark treatment rather than following the theme. A login
 * page is seen for ten seconds before the app proper, and it is the only
 * screen that is purely the brand's — everything after it belongs to the work.
 *
 * The motif behind the card is a month grid with a scatter of days marked,
 * which is literally what this portal is: a month of content, planned, going
 * out on the days it should. Drawn in CSS rather than an image, so there is
 * nothing to load and nothing for the CSP to block.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  const user = await getSession();
  if (user) redirect(homeForRole(user.role));

  const expired = (await searchParams).expired === "1";

  /* A month, with the days that carry work. Fixed, not random: a layout that
     reshuffles on every render is noise, and this one reads as a real
     schedule — busier midweek, quieter at the weekend. */
  const marked = new Set([2, 4, 8, 10, 11, 15, 17, 22, 24, 25, 29]);
  const strong = new Set([4, 11, 17, 25]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0d0c0f] text-white">
      {/* Warmth from the top-left, so the card sits in light rather than on a flat ground. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(48rem 40rem at 12% -8%, rgba(249,115,22,0.30), transparent 60%)," +
            "radial-gradient(38rem 34rem at 88% 108%, rgba(217,119,6,0.18), transparent 62%)",
        }}
      />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center gap-14 px-6 py-12 lg:flex-row lg:justify-between">
        {/* The pitch, and the motif */}
        <div className="w-full max-w-lg">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-orange-500 text-sm font-bold text-white">
              N
            </span>
            <span className="text-lg font-semibold tracking-tight">NVK Hub</span>
          </div>

          <h1 className="mt-10 text-[2.6rem] font-semibold leading-[1.1] tracking-tight">
            A month of content,
            <br />
            <span className="text-orange-400">handled.</span>
          </h1>
          <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-white/55">
            Plans, shoots, approvals over WhatsApp, captions written by AI, and
            posting that happens on its own.
          </p>

          {/* The month grid. Marked days are the work; the brighter ones went out. */}
          <div
            aria-hidden
            className="mt-12 hidden w-fit grid-cols-7 gap-1.5 lg:grid"
          >
            {Array.from({ length: 35 }).map((_, i) => {
              const day = i - 2;
              const has = marked.has(day);
              const out = strong.has(day);
              return (
                <span
                  key={i}
                  className="h-7 w-7 rounded-[0.3rem] border"
                  style={{
                    borderColor: out
                      ? "rgba(249,115,22,0.55)"
                      : has
                        ? "rgba(255,255,255,0.16)"
                        : "rgba(255,255,255,0.07)",
                    background: out
                      ? "rgba(249,115,22,0.35)"
                      : has
                        ? "rgba(255,255,255,0.07)"
                        : "transparent",
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* The card */}
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-7 shadow-2xl backdrop-blur-sm">
            <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
            <p className="mt-1 text-sm text-white/45">
              Welcome back. Pick up where you left off.
            </p>

            {/* Says why, rather than leaving someone to wonder whether they
                were signed out or something broke. */}
            {expired ? (
              <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Your session ended after an hour. Sign in again to carry on —
                  nothing you saved has been lost.
                </span>
              </div>
            ) : null}

            {/* The form's own inputs follow the app's tokens, which are light.
                Scoped overrides here rather than new variants on the shared
                components: this is the only dark surface in the portal, and a
                dark variant nothing else uses would be a component to maintain
                for one screen. */}
            <div className="mt-6 [&_input]:border-white/15 [&_input]:bg-white/[0.06] [&_input]:text-white [&_input]:placeholder:text-white/30 [&_label]:text-white/70">
              <LoginForm />
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-white/30">
            © {new Date().getFullYear()} NVK Hub
          </p>
        </div>
      </div>
    </main>
  );
}

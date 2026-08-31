import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Multiple lockfiles exist above this folder; pin the workspace root so
  // Turbopack resolves modules from agency-next/.
  turbopack: {
    root: path.resolve(__dirname),
  },

  /**
   * Which build a page came from, stamped into the page itself.
   *
   * Every Server Action is addressed by an ID baked into the build, and a new
   * deployment gives it a new one. A tab left open across a deploy therefore
   * calls an address that no longer exists, and Next answers "Server Action
   * … was not found on the server" — a dead end for the person looking at it,
   * whose page appears to work right up until they press the button.
   *
   * With a deployment ID set, Next puts it on the html element and on every
   * navigation response, and a client that sees a different one reloads the
   * whole page instead of continuing against a build it no longer matches.
   * The stale tab repairs itself rather than failing at the first action.
   *
   * Vercel supplies the value; locally there is nothing to be out of step
   * with, so undefined is the right answer and turns the feature off.
   */
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA,
};

export default nextConfig;

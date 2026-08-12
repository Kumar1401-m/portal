/**
 * Lets plain node run the portal's own .ts modules:
 *   - "server-only" becomes a no-op (Next supplies it at build time)
 *   - "@/x" resolves to src/x
 *   - extensionless relative imports get .ts / .tsx
 */
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const SRC = process.env.PORTAL_SRC;

function withExt(p) {
  for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
    if (fs.existsSync(p + ext) && fs.statSync(p + ext).isFile()) return p + ext;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const hit = withExt(path.join(SRC, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const base = path.dirname(fileURLToPath(context.parentURL));
      const hit = withExt(path.resolve(base, specifier));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

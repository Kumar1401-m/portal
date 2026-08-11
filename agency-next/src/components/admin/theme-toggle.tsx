"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle. Persists to localStorage and toggles the `.dark` class.
 *
 * The current theme is not this component's state — it is a class on
 * `<html>`, put there by an inline script before React runs so the page never
 * flashes white. Copying it into `useState` from an effect made a second,
 * lagging copy of something the DOM already knew, and left the icon wrong if
 * anything else ever changed the class.
 *
 * So it is read as what it is: external state, observed. The observer also
 * means the icon stays right when the theme is changed from somewhere else —
 * another tab's toggle writing the class, say.
 */
const subscribe = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
};

const isDark = () => document.documentElement.classList.contains("dark");
// The server has no DOM and no preference; light matches the un-themed markup.
const isDarkOnServer = () => false;

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, isDarkOnServer);

  function toggle() {
    const next = !isDark();
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    // No setState: the class changed, the observer fires, React re-reads.
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}

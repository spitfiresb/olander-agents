"use client";

import { useEffect, useRef, useState } from "react";
import { getMicrosoftSignInUrl, signInWithMicrosoft } from "./actions";
import { PaintReveal } from "./PaintReveal";

// Timing of the spill, in click-relative ms:
//   • 0–~2130ms — spread: latest blob finishes at delay(330) + duration(1800).
//   • 2130–2200ms — brief hold so the page reads as fully red before the nav.
//   • 2200ms — navigate. The Microsoft URL is prefetched at click + the
//     browser is given speculation-rule hints, so the cross-origin commit is
//     as fast as it can be. The browser holds the fully-red frame visible
//     until Microsoft renders — so the user sees red → Microsoft, never
//     red → blank → Microsoft.
const ANIMATION_END_MS = 2200;

export function SignInPanel() {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // Tracked in state so the speculation-rules + prefetch tags re-render once
  // we have a URL — the browser then starts fetching Microsoft concurrent
  // with the rest of the paint animation.
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const spilling = origin !== null;

  // React 19 refuses to execute <script> tags it renders client-side, so the
  // speculation-rules hint has to be injected via DOM. Fires once we have a
  // URL; cleaned up if the component unmounts before nav (it usually won't).
  useEffect(() => {
    if (!signInUrl) return;
    const el = document.createElement("script");
    el.type = "speculationrules";
    el.textContent = JSON.stringify({
      prerender: [
        { source: "list", urls: [signInUrl], eagerness: "eager" },
      ],
      prefetch: [
        { source: "list", urls: [signInUrl], eagerness: "eager" },
      ],
    });
    document.head.appendChild(el);
    return () => {
      if (el.parentNode === document.head) document.head.removeChild(el);
    };
  }, [signInUrl]);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (spilling) return;

    // Reduced-motion users get the direct path — no preventDefault, the form
    // submits normally and they're on Microsoft within a frame.
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    e.preventDefault();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    setOrigin({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });

    // Kick off the Microsoft OAuth URL fetch immediately. The closure
    // captures the Promise so the setTimeout below can await it without
    // racing the React state update.
    const urlPromise = getMicrosoftSignInUrl()
      .then((url) => {
        // Setting state triggers re-render → renders <link rel="prefetch">
        // and the speculation-rules <script>. Browser then warms its cache
        // with Microsoft's HTML response while the animation finishes.
        setSignInUrl(url);
        return url;
      })
      .catch((err: unknown) => {
        console.error("[sign-in] URL prefetch failed:", err);
        return null;
      });

    window.setTimeout(async () => {
      const url = await urlPromise;
      if (url) {
        window.location.assign(url);
      } else {
        // Prefetch failed — fall back to the regular form-action redirect,
        // which goes through the same server action but redirects server-side.
        formRef.current?.requestSubmit();
      }
    }, ANIMATION_END_MS);
  }

  return (
    <>
      {/* <link rel="prefetch"> is a resource hint — React 19 hoists these
          into <head> happily. The Speculation Rules <script> can't go here
          (React won't execute scripts it renders client-side); it's injected
          via the useEffect above. Together: prefetch caches Microsoft's HTML
          response, speculation rules attempt the more powerful prerender. */}
      {signInUrl ? (
        <link rel="prefetch" href={signInUrl} as="document" />
      ) : null}
      <div
        className="w-full max-w-sm transition-opacity duration-300"
        // Fade the panel out once spilling starts. The paint covers it
        // anyway, but during the shrink phase the red contracts and would
        // otherwise reveal the panel before the navigation lands.
        style={{ opacity: spilling ? 0 : 1 }}
      >
        <p className="mb-3 text-center text-sm text-brand-ink-soft sm:text-base">
          Continue with your Microsoft account.
        </p>
        <form ref={formRef} action={signInWithMicrosoft}>
          <button
            ref={buttonRef}
            type="submit"
            onClick={handleClick}
            disabled={spilling}
            className="flex h-11 w-full items-center justify-center rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 disabled:opacity-100"
          >
            Sign in
          </button>
        </form>
      </div>
      {spilling && origin ? (
        <PaintReveal originX={origin.x} originY={origin.y} />
      ) : null}
    </>
  );
}

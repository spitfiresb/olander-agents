"use server";

import { signIn } from "@/auth";

export async function signInWithMicrosoft() {
  await signIn("microsoft-entra-id", { redirectTo: "/chat" });
}

// Variant for the animated sign-in flow: instead of throwing NEXT_REDIRECT,
// returns the Microsoft authorize URL so the client can navigate manually
// once the spill animation finishes. Auth.js still sets the state + PKCE
// cookies on this response (see node_modules/next-auth/src/lib/actions.ts —
// `cookieJar.set` runs unconditionally), so the callback can verify state
// when Microsoft redirects back. Called concurrently with the animation —
// by the time we navigate at shrink-end, only the cross-origin fetch of
// Microsoft's page remains, not our server roundtrip.
export async function getMicrosoftSignInUrl(): Promise<string> {
  const url = await signIn("microsoft-entra-id", {
    redirect: false,
    redirectTo: "/chat",
  });
  if (typeof url !== "string") {
    throw new Error(
      `Expected signIn to return a URL string, got ${typeof url}`,
    );
  }
  return url;
}

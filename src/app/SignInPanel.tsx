import { signInWithMicrosoft } from "./actions";

export function SignInPanel() {
  return (
    <div className="w-full max-w-sm">
      <p className="mb-3 text-center text-sm text-brand-ink-soft sm:text-base">
        Continue with your Microsoft account.
      </p>
      <form action={signInWithMicrosoft}>
        <button
          type="submit"
          className="flex h-11 w-full items-center justify-center rounded-md bg-brand-red px-6 text-sm font-medium text-white transition-colors hover:bg-brand-red/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}

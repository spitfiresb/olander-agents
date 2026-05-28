// Web Speech API lives at two global names depending on the browser
// (`SpeechRecognition` on standard implementations, `webkitSpeechRecognition`
// on Safari/older Chrome). Firefox omits both. This module is the single
// detection surface so the hook stays untested at unit level (the rest of
// the hook needs the DOM) while the branch logic here is exercised in node.

type Globals = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

// Returns the available constructor or null. Pass `global` explicitly in
// tests; in the browser it defaults to `window`. The return is typed loosely
// because the hook treats instances as a minimal shape — we don't depend on
// the full SpeechRecognition interface and the lib.dom typings disagree on
// the webkit-prefixed name.
export function getSpeechRecognitionCtor(
  global?: Globals,
): (new () => unknown) | null {
  const source: Globals =
    global ?? (typeof window === "undefined" ? {} : (window as unknown as Globals));
  const std = source.SpeechRecognition;
  if (typeof std === "function") return std as new () => unknown;
  const webkit = source.webkitSpeechRecognition;
  if (typeof webkit === "function") return webkit as new () => unknown;
  return null;
}

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getSpeechRecognitionCtor } from "./speech-recognition";

// Minimal slice of the SpeechRecognition interface the hook uses. The real
// interface is richer; we only set/read these fields so the loose shape is
// safer than fighting lib.dom across browsers (webkit-prefixed name has
// patchy typings).
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript?: string }>>;
};

type SpeechErrorEvent = { error?: string };

type Opts = {
  onFinalTranscript: (text: string) => void;
};

type Result = {
  supported: boolean;
  listening: boolean;
  error: "mic_blocked" | "mic_error" | null;
  start: () => void;
  stop: () => void;
};

// useSyncExternalStore is the React-blessed way to read a client-only
// capability without writing to state inside an effect (which triggers the
// react-hooks/set-state-in-effect lint rule and causes cascading renders).
// The subscribe noop is fine — capability doesn't change after page load.
const subscribeNoop = () => () => {};
const detectSupported = () => getSpeechRecognitionCtor() !== null;
const serverSupported = () => false;

// Single-utterance dictation: continuous=false so the first natural pause
// finalizes the transcript. interimResults=false because we can't easily
// render interim text inside a <textarea> without cursor-position pain;
// the consumer just receives the final string and appends it.
export function useSpeechRecognition({ onFinalTranscript }: Opts): Result {
  const supported = useSyncExternalStore(
    subscribeNoop,
    detectSupported,
    serverSupported,
  );
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<Result["error"]>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Latest callback in a ref so the recognition instance built once on mount
  // never closes over a stale consumer state (the composer's onFinalTranscript
  // typically reads the latest input value via a functional setter, but the
  // ref keeps the hook agnostic to that pattern).
  const onFinalRef = useRef(onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  useEffect(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor() as SpeechRecognitionLike;
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language
        : "en-US";
    rec.onresult = (event) => {
      let text = "";
      const results = event.results;
      for (let i = 0; i < results.length; i++) {
        const alt = results[i]?.[0];
        if (alt?.transcript) text += alt.transcript;
      }
      const trimmed = text.trim();
      if (trimmed) onFinalRef.current(trimmed);
    };
    rec.onerror = (event) => {
      // no-speech and aborted are normal terminations (user said nothing, or
      // we called stop()/abort() ourselves) — don't surface either as an error.
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(event.error === "not-allowed" ? "mic_blocked" : "mic_error");
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    return () => {
      try {
        rec.abort();
      } catch {
        // already stopped or never started
      }
      recRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    setError(null);
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws InvalidStateError if already started — treat as no-op
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // stop() throws if not started — ignore
    }
  }, []);

  return { supported, listening, error, start, stop };
}

import { describe, expect, test } from "vitest";
import { getSpeechRecognitionCtor } from "@/lib/voice/speech-recognition";

describe("getSpeechRecognitionCtor", () => {
  test("returns null when neither constructor is on the global", () => {
    expect(getSpeechRecognitionCtor({})).toBeNull();
  });

  test("returns the standard SpeechRecognition constructor when present", () => {
    function FakeRec() {}
    expect(getSpeechRecognitionCtor({ SpeechRecognition: FakeRec })).toBe(FakeRec);
  });

  test("falls back to webkitSpeechRecognition when standard is missing", () => {
    function FakeWebkit() {}
    expect(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeWebkit })).toBe(
      FakeWebkit,
    );
  });

  test("prefers standard over webkit when both are present", () => {
    function Std() {}
    function Webkit() {}
    expect(
      getSpeechRecognitionCtor({
        SpeechRecognition: Std,
        webkitSpeechRecognition: Webkit,
      }),
    ).toBe(Std);
  });

  test("returns null when SpeechRecognition is not a function", () => {
    expect(getSpeechRecognitionCtor({ SpeechRecognition: "nope" })).toBeNull();
  });

  test("returns null when webkitSpeechRecognition is not a function", () => {
    expect(
      getSpeechRecognitionCtor({ webkitSpeechRecognition: { not: "a-fn" } }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { slugify } from "../slug";

describe("slugify", () => {
  it("lowercases and dashes spaces", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses runs of non-alphanumeric into a single dash", () => {
    expect(slugify("foo   ___  bar!!!")).toBe("foo-bar");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("...edge...")).toBe("edge");
  });

  it("strips diacritics to their ASCII base", () => {
    expect(slugify("Müller café résumé")).toBe("muller-cafe-resume");
  });

  it("caps at 80 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(80);
  });

  it("returns an empty string for input with no alphanumerics", () => {
    expect(slugify("!!! ???")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("handles fastener-shaped titles (real-world)", () => {
    expect(slugify("M10 1.25 socket head cap screws")).toBe(
      "m10-1-25-socket-head-cap-screws",
    );
  });
});

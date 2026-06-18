import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  docxBufferToText,
  isOfficeDocMimeType,
  pptxBufferToText,
  DOCX_MIME,
  PPTX_MIME,
} from "@/lib/office";

// Build an OOXML zip (.docx/.pptx are both zip containers) from a path→string
// map, the same way fflate packs real archives.
function buildZip(entries: Record<string, string>): Uint8Array {
  const packed: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(entries)) {
    packed[path] = strToU8(content);
  }
  return zipSync(packed);
}

// A minimal-but-valid .docx package: content types, the package relationship
// pointing at the main document part, and the document body itself.
function minimalDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`,
  });
}

// A .pptx slide part. `lines` become <a:p> paragraphs, each a single <a:t> run.
function slideXml(lines: string[]): string {
  const paras = lines
    .map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${paras}</p:spTree></p:cSld>
</p:sld>`;
}

describe("isOfficeDocMimeType", () => {
  test("matches docx and pptx, case-insensitively", () => {
    expect(isOfficeDocMimeType(DOCX_MIME)).toBe(true);
    expect(isOfficeDocMimeType(PPTX_MIME)).toBe(true);
    expect(isOfficeDocMimeType(DOCX_MIME.toUpperCase())).toBe(true);
  });

  test("does not match spreadsheets, pdf, or falsy input", () => {
    expect(
      isOfficeDocMimeType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(false);
    expect(isOfficeDocMimeType("application/pdf")).toBe(false);
    expect(isOfficeDocMimeType(undefined)).toBe(false);
    expect(isOfficeDocMimeType(null)).toBe(false);
    expect(isOfficeDocMimeType("")).toBe(false);
  });
});

describe("docxBufferToText", () => {
  test("extracts paragraph text in order", async () => {
    const buf = minimalDocx(["Hello world", "Second paragraph"]);
    const text = await docxBufferToText(buf);
    expect(text).toContain("Hello world");
    expect(text).toContain("Second paragraph");
    expect(text.indexOf("Hello world")).toBeLessThan(
      text.indexOf("Second paragraph"),
    );
  });
});

describe("pptxBufferToText", () => {
  test("extracts slide text with per-slide markers", () => {
    const buf = buildZip({
      "ppt/slides/slide1.xml": slideXml(["Title slide", "subtitle here"]),
      "ppt/slides/slide2.xml": slideXml(["Second slide bullet"]),
    });
    const text = pptxBufferToText(buf);
    expect(text).toContain("--- Slide 1 ---");
    expect(text).toContain("Title slide");
    expect(text).toContain("subtitle here");
    expect(text).toContain("--- Slide 2 ---");
    expect(text).toContain("Second slide bullet");
    expect(text.indexOf("Slide 1")).toBeLessThan(text.indexOf("Slide 2"));
  });

  test("orders slides numerically (slide10 after slide2), not lexically", () => {
    const buf = buildZip({
      "ppt/slides/slide1.xml": slideXml(["one"]),
      "ppt/slides/slide2.xml": slideXml(["two"]),
      "ppt/slides/slide10.xml": slideXml(["ten"]),
    });
    const text = pptxBufferToText(buf);
    expect(text.indexOf("two")).toBeLessThan(text.indexOf("ten"));
  });

  test("decodes XML entities in run text", () => {
    const buf = buildZip({
      "ppt/slides/slide1.xml": slideXml(["R&amp;D &lt;notes&gt;"]),
    });
    expect(pptxBufferToText(buf)).toContain("R&D <notes>");
  });

  test("returns empty string when there are no slides", () => {
    const buf = buildZip({ "ppt/presentation.xml": "<p:presentation/>" });
    expect(pptxBufferToText(buf)).toBe("");
  });
});

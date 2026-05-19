import { describe, expect, it } from "vitest";
import { toCsv, toMarkdown, toTsv } from "../tool-result-format";

describe("toCsv", () => {
  it("emits header + row lines for simple data", () => {
    const out = toCsv([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
    expect(out).toBe("a,b\n1,2\n3,4");
  });

  it("quotes cells containing commas", () => {
    expect(toCsv([{ name: "Smith, John" }])).toBe('name\n"Smith, John"');
  });

  it("doubles internal quotes inside quoted cells", () => {
    expect(toCsv([{ note: 'He said "hi"' }])).toBe('note\n"He said ""hi"""');
  });

  it("quotes cells containing newlines or carriage returns", () => {
    expect(toCsv([{ desc: "line1\nline2" }])).toBe(
      'desc\n"line1\nline2"',
    );
    expect(toCsv([{ desc: "line1\r\nline2" }])).toBe(
      'desc\n"line1\r\nline2"',
    );
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv([{ a: null, b: undefined, c: "ok" }])).toBe("a,b,c\n,,ok");
  });

  it("returns an empty string for an empty array", () => {
    expect(toCsv([])).toBe("");
  });

  it("unions headers across mixed-shape rows in first-seen order", () => {
    const out = toCsv([
      { a: 1, b: 2 },
      { c: 3, a: 1 },
    ]);
    expect(out).toBe("a,b,c\n1,2,\n1,,3");
  });

  it("renders Date cells as ISO strings", () => {
    const d = new Date("2026-05-19T12:00:00.000Z");
    expect(toCsv([{ ts: d }])).toBe("ts\n2026-05-19T12:00:00.000Z");
  });

  it("compact-stringifies nested objects and arrays", () => {
    expect(toCsv([{ meta: { a: 1 } }])).toBe('meta\n"{""a"":1}"');
    expect(toCsv([{ tags: ["x", "y"] }])).toBe('tags\n"[""x"",""y""]"');
  });

  it("preserves numbers and booleans", () => {
    expect(toCsv([{ n: 42, b: true, f: false }])).toBe("n,b,f\n42,true,false");
  });
});

describe("toTsv", () => {
  it("emits tab-separated header + rows", () => {
    expect(toTsv([{ a: "1", b: "2" }])).toBe("a\tb\n1\t2");
  });

  it("collapses tabs inside cells to a single space", () => {
    expect(toTsv([{ desc: "a\tb\tc" }])).toBe("desc\na b c");
  });

  it("collapses newlines inside cells to a single space", () => {
    expect(toTsv([{ desc: "line1\nline2" }])).toBe("desc\nline1 line2");
    expect(toTsv([{ desc: "line1\r\nline2" }])).toBe("desc\nline1 line2");
  });

  it("returns an empty string for an empty array", () => {
    expect(toTsv([])).toBe("");
  });

  it("preserves commas inside cells without quoting", () => {
    expect(toTsv([{ name: "Smith, John" }])).toBe("name\nSmith, John");
  });
});

describe("toMarkdown", () => {
  it("emits a GFM-style table with header divider", () => {
    expect(toMarkdown([{ a: "1", b: "2" }])).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("escapes pipes inside cells", () => {
    expect(toMarkdown([{ note: "a | b" }])).toBe(
      "| note |\n| --- |\n| a \\| b |",
    );
  });

  it("collapses newlines in cells to a single space", () => {
    expect(toMarkdown([{ desc: "line1\nline2" }])).toBe(
      "| desc |\n| --- |\n| line1 line2 |",
    );
  });

  it("returns an empty string for an empty array", () => {
    expect(toMarkdown([])).toBe("");
  });

  it("renders null and undefined as empty cells", () => {
    expect(toMarkdown([{ a: null, b: undefined }])).toBe(
      "| a | b |\n| --- | --- |\n|  |  |",
    );
  });
});

describe("real-world shapes", () => {
  it("serializes a typical viewsQuery result (P21 row shape)", () => {
    const rows = [
      {
        item_id: "PN12345",
        item_desc: "SHCS M10x30",
        qty_on_hand: 482,
        delete_flag: false,
      },
      {
        item_id: "P26745",
        item_desc: "SHCS M10x40",
        qty_on_hand: 314,
        delete_flag: false,
      },
    ];
    expect(toCsv(rows)).toBe(
      "item_id,item_desc,qty_on_hand,delete_flag\n" +
        "PN12345,SHCS M10x30,482,false\n" +
        "P26745,SHCS M10x40,314,false",
    );
  });

  it("serializes a single-row entityGet result as a markdown table", () => {
    const rows = [
      {
        customer_id: "ACME",
        customer_name: "Acme Industries",
        city: "Portland",
        state: "OR",
      },
    ];
    expect(toMarkdown(rows)).toBe(
      "| customer_id | customer_name | city | state |\n" +
        "| --- | --- | --- | --- |\n" +
        "| ACME | Acme Industries | Portland | OR |",
    );
  });

  it("serializes searchCatalog matches with score column intact", () => {
    const rows = [
      { item_id: "PN12345", item_desc: "SHCS M10", score: 0.91 },
      { item_id: "P26745", item_desc: "SHCS M10x40", score: 0.88 },
    ];
    expect(toTsv(rows)).toBe(
      "item_id\titem_desc\tscore\n" +
        "PN12345\tSHCS M10\t0.91\n" +
        "P26745\tSHCS M10x40\t0.88",
    );
  });
});

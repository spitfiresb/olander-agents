import { describe, expect, test } from "vitest";
import * as XLSX from "xlsx";
import { excelBufferToCsv } from "@/lib/excel";

function buildWorkbook(rows: Array<Array<string | number>>): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("excelBufferToCsv", () => {
  test("converts a simple part-list-style sheet to CSV", () => {
    const buf = buildWorkbook([
      ["item_id", "qty"],
      ["PN12345-01", 100],
      ["M10-1.5", 250],
    ]);
    const csv = excelBufferToCsv(buf);
    expect(csv).toContain("item_id,qty");
    expect(csv).toContain("PN12345-01,100");
    expect(csv).toContain("M10-1.5,250");
  });

  test("only emits the first sheet (v1 behavior)", () => {
    const ws1 = XLSX.utils.aoa_to_sheet([["sheet1_value"]]);
    const ws2 = XLSX.utils.aoa_to_sheet([["sheet2_value"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "First");
    XLSX.utils.book_append_sheet(wb, ws2, "Second");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const csv = excelBufferToCsv(buf);
    expect(csv).toContain("sheet1_value");
    expect(csv).not.toContain("sheet2_value");
  });

  test("returns empty string for a sheet with no rows", () => {
    const ws = XLSX.utils.aoa_to_sheet([]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(excelBufferToCsv(buf).trim()).toBe("");
  });

  test("accepts a Uint8Array buffer", () => {
    const buf = buildWorkbook([["a", "b"], [1, 2]]);
    const u8 = new Uint8Array(buf);
    expect(excelBufferToCsv(u8)).toContain("a,b");
  });
});

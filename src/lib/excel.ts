import * as XLSX from "xlsx";

// Server-side Excel→CSV conversion. Anthropic's model API doesn't accept
// .xlsx natively, so the chat route fetches the uploaded blob and synthesizes
// a text part with the CSV body. The original blob URL stays in message.parts
// so the rep can still download the source file from their chip.
//
// v1 emits the first sheet only. If reps drop multi-sheet workbooks where
// the second sheet matters, concatenate (handoff §4, "Edge cases").

export function excelBufferToCsv(buffer: ArrayBuffer | Uint8Array): string {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const workbook = XLSX.read(data, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return "";
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return "";
  return XLSX.utils.sheet_to_csv(sheet);
}

export async function fetchAndConvertExcel(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`excel_fetch_failed:${resp.status}`);
  }
  const buffer = await resp.arrayBuffer();
  return excelBufferToCsv(buffer);
}

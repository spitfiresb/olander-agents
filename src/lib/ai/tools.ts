import { tool } from "ai";
import { z } from "zod";

const inventorySearch = tool({
  description:
    "Search Olander's warehouse inventory. Use for any rep question that asks what's in stock — by thread size, material, length, finish, SKU, or free-text.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Free-text search: thread size, material, length, finish, SKU, etc."),
  }),
  execute: async ({ query }) => {
    const url = process.env.DROPLET_PROXY_URL;
    const token = process.env.DROPLET_PROXY_TOKEN;
    if (!url || !token) {
      return { error: "proxy_not_configured" as const };
    }

    let res: Response;
    try {
      res = await fetch(`${url}/proxy/inventory_search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      return {
        error: "proxy_unreachable" as const,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (res.status === 503) {
      return { error: "credentials_pending" as const };
    }
    if (!res.ok) {
      return { error: `proxy_http_${res.status}` as const };
    }
    return (await res.json()) as unknown;
  },
});

export const tools = { inventorySearch } as const;

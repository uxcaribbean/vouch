/**
 * Trader/taxonomy shared bits — M2.
 */
import { z } from "zod";

/** "AC & Fridge Repair!" → "ac-fridge-repair" (also used by M9 merges). */
export function slugifyTrade(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const TRADER_MAX_TRADES = 5;

/** M2 — become-a-trader wizard submit / trader profile edit. */
export const UpsertTraderProfileSchema = z
  .object({
    business_name: z.string().trim().max(80).optional(),
    bio: z.string().trim().max(300).optional(),
    photo_url: z.string().url().optional(),
    /** ids from the trades taxonomy (active or proposed) */
    trade_ids: z.array(z.number().int().positive()).max(TRADER_MAX_TRADES),
    /** free-text services not in the taxonomy → created as 'proposed' */
    proposed_trades: z
      .array(z.string().trim().min(3).max(60))
      .max(3)
      .default([]),
    /** region ids served; id 1 (Trinidad parent) = island-wide shortcut */
    region_ids: z.array(z.number().int().positive()).min(1).max(20),
  })
  .refine(
    (v) =>
      v.trade_ids.length + v.proposed_trades.length >= 1 &&
      v.trade_ids.length + v.proposed_trades.length <= TRADER_MAX_TRADES,
    { message: `Pick between 1 and ${TRADER_MAX_TRADES} services` },
  );
export type UpsertTraderProfileInput = z.infer<
  typeof UpsertTraderProfileSchema
>;

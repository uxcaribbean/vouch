/**
 * /v/{token} — the no-install web vouch flow (spec M7).
 *
 * A Server Component on purpose: the trader card is the first thing a cold
 * visitor sees off a WhatsApp link, so it ships in the HTML with zero client
 * JS. Only the stepper below it (<VouchFlow>) hydrates.
 *
 * resolve-invite is public (verify_jwt=false) and answers every bad token
 * with a 200 + { valid:false }, so this page branches on the payload rather
 * than on HTTP status.
 */
import { cache } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { VouchFlow } from "./vouch-flow";
import type { Resolution, ResolvedTrader } from "./types";

const API_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Cached per-request so generateMetadata and the page body share one call —
 * resolve-invite logs an `invite_link_opened` event, and one page view is
 * one open.
 */
const resolveInvite = cache(async (token: string): Promise<Resolution> => {
  if (!API_URL || !ANON_KEY) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — copy apps/web/.env.example to .env.local",
    );
  }
  try {
    const res = await fetch(`${API_URL}/functions/v1/resolve-invite`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    if (!res.ok) return { valid: false };
    return (await res.json()) as Resolution;
  } catch {
    // Stack down / offline: same friendly dead-end as a bad token.
    return { valid: false };
  }
});

/** Display name for the card: the business if there is one, else the person. */
function cardName(trader: ResolvedTrader): string {
  return trader.business_name ?? trader.display_name ?? "This trader";
}

/** "Vouch for Keisha" reads warmer than "Vouch for Keisha Mohammed". */
function firstName(trader: ResolvedTrader): string {
  const person = trader.display_name ?? trader.business_name ?? "";
  return person.trim().split(/\s+/)[0] || "them";
}

/** Next 16: dynamic route params arrive as a promise and must be awaited. */
type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const resolution = await resolveInvite(token);
  if (resolution.valid && resolution.kind === "vouch_request") {
    return { title: `Vouch for ${cardName(resolution.trader)} — VOUCH` };
  }
  return { title: "Vouch link — VOUCH" };
}

export default async function VouchLinkPage({ params }: Props) {
  const { token } = await params;
  const resolution = await resolveInvite(token);

  // A join link that landed on the vouch route is still a join link.
  if (resolution.valid && resolution.kind === "join_invite") {
    redirect(`/join?code=${encodeURIComponent(resolution.referral_code)}`);
  }

  if (!resolution.valid) {
    return resolution.expired ? (
      <DeadEnd
        heading="This vouch link has expired."
        body="Vouch links live for 30 days — ask them to send you a fresh one."
      />
    ) : (
      <DeadEnd
        heading="This link isn't working."
        body="Check you copied the whole thing, or ask for a new link."
      />
    );
  }

  const { trader, referral_code } = resolution;

  return (
    <div className="min-h-dvh bg-zinc-50 px-5 py-10 font-sans text-black dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-md flex-col gap-8">
        <section className="flex flex-col items-center gap-4 text-center">
          {(trader.photo_url ?? trader.avatar_url) ? (
            /* Plain <img>, not next/image: avatars come from whatever
               Supabase Storage host the environment uses, so next/image
               would mean pinning remotePatterns per environment for one
               80px thumbnail. alt="" because the name renders right below. */
            <img
              src={trader.photo_url ?? trader.avatar_url ?? ""}
              alt=""
              className="size-20 rounded-full border border-zinc-300 object-cover dark:border-zinc-700"
            />
          ) : (
            <div
              aria-hidden
              className="size-20 rounded-full border border-zinc-300 bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800"
            />
          )}

          <h1 className="text-3xl font-semibold tracking-tight">
            {cardName(trader)}
          </h1>

          {trader.trades.length > 0 && (
            <ul className="flex flex-wrap justify-center gap-2">
              {trader.trades.map((trade) => (
                <li
                  key={trade.id}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                >
                  {trade.name}
                </li>
              ))}
            </ul>
          )}

          <p className="text-lg text-zinc-600 dark:text-zinc-400">
            Vouch for {firstName(trader)}
          </p>
        </section>

        <VouchFlow
          token={token}
          trader={trader}
          traderFirstName={firstName(trader)}
          referralCode={referral_code}
        />
      </main>
    </div>
  );
}

function DeadEnd({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center font-sans dark:bg-black">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        {heading}
      </h1>
      <p className="max-w-sm text-zinc-600 dark:text-zinc-400">{body}</p>
      <Link
        href="/"
        className="mt-2 underline underline-offset-4 hover:no-underline"
      >
        Go to VOUCH
      </Link>
    </div>
  );
}

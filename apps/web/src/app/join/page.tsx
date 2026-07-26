/**
 * /join — where the success screen's "Join free" CTA and every join_invite
 * link land (spec M6.2/M7.3). Deliberately one screen and zero client JS:
 * until the apps ship there is nothing to sign up for here, so the page's
 * whole job is to hold the referral code and set expectations honestly.
 */
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Join VOUCH — free for your first 6 months",
};

/** Next 16: searchParams arrive as a promise and must be awaited. */
type Props = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function JoinPage({ searchParams }: Props) {
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();

  return (
    <div className="min-h-dvh bg-zinc-50 px-5 py-16 font-sans text-black dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6">
        <h1 className="text-3xl font-semibold tracking-tight">
          Find trades &amp; services vouched by people you actually know.
        </h1>

        {code && (
          <div className="rounded-lg border border-black px-5 py-4 text-lg dark:border-zinc-50">
            Join free with code{" "}
            <span className="font-mono font-semibold tracking-wider">{code}</span>{" "}
            — your first 6 months are on us.
          </div>
        )}

        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          The app is coming to iOS &amp; Android. For now, the person who
          invited you can show you around.
        </p>

        <Link
          href="/"
          className="w-fit text-lg underline underline-offset-4 hover:no-underline"
        >
          Go to VOUCH
        </Link>
      </main>
    </div>
  );
}

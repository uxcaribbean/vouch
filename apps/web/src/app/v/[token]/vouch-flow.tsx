"use client";

/**
 * The 60-second moment (spec M7.2–M7.3): phone → OTP → (name) → vouch.
 *
 * This is the only client JS on the page, so it stays dependency-free and
 * hand-rolled: one state machine, no form library, no animation library.
 * Every step is a real <form> so Enter submits and mobile keyboards show a
 * "Go" key; inputs are h-14/text-lg because this runs one-handed on a phone
 * over mobile data.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { normalizePhone } from "@vouch/shared";
import { invokeFunction, supabase } from "@/lib/supabase";
import type { ResolvedTrader } from "./types";

const MAX_COMMENT = 400;
const RESEND_SECONDS = 30;

type Step = "phone" | "otp" | "name" | "compose" | "done";

const FIELD =
  "h-14 w-full rounded-lg border border-zinc-300 bg-white px-4 text-lg text-black outline-none placeholder:text-zinc-400 focus:border-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:focus:border-zinc-400";
const BUTTON =
  "h-14 w-full rounded-lg bg-black text-lg font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-black";
const HELPER = "text-sm text-zinc-500 dark:text-zinc-400";

function Err({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}

export function VouchFlow({
  token,
  trader,
  traderFirstName,
  referralCode,
}: {
  token: string;
  trader: ResolvedTrader;
  traderFirstName: string;
  referralCode: string | null;
}) {
  const [step, setStep] = useState<Step>("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // phone / otp
  const [phoneInput, setPhoneInput] = useState("");
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);

  // name
  const [name, setName] = useState("");

  // compose
  const [tradeId, setTradeId] = useState<number | null>(
    trader.trades.length === 1 ? trader.trades[0].id : null,
  );
  const [comment, setComment] = useState("");
  const [created, setCreated] = useState(true);

  // Guards the OTP auto-submit so a fast typist can't fire two verifies.
  const verifying = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode(phone: string) {
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone });
    if (otpError) {
      setError("We couldn't send that code. Try again in a moment.");
      return false;
    }
    setCooldown(RESEND_SECONDS);
    return true;
  }

  async function submitPhone(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const normalized = normalizePhone(phoneInput);
    if (!normalized) {
      setError("That doesn't look like a phone number.");
      return;
    }
    setBusy(true);
    setE164(normalized);
    if (await sendCode(normalized)) {
      setCode("");
      setStep("otp");
    }
    setBusy(false);
  }

  /** Verify, then decide whether this person still needs an account. */
  async function verify(sixDigits: string) {
    if (!e164 || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setError(null);

    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      phone: e164,
      token: sixDigits,
      type: "sms",
    });

    if (verifyError || !data.user) {
      setError("That code didn't work. Check it and try again.");
      setCode("");
      setBusy(false);
      verifying.current = false;
      return;
    }

    // A users row means they're already a member (mobile signup, or an
    // earlier web vouch) — skip the name step entirely.
    const { data: profile } = await supabase
      .from("users")
      .select("id")
      .eq("id", data.user.id)
      .maybeSingle();

    setStep(profile ? "compose" : "name");
    setBusy(false);
    verifying.current = false;
  }

  async function resend() {
    if (busy || cooldown > 0 || !e164) return;
    setBusy(true);
    setError(null);
    setCode("");
    await sendCode(e164);
    setBusy(false);
  }

  async function submitName(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError("Tell us what to call you.");
      return;
    }
    setBusy(true);
    // Region is deliberately omitted — spec M7.2 is a minimal account.
    const { errorCode } = await invokeFunction("complete-profile", {
      display_name: name.trim(),
    });
    setBusy(false);
    if (errorCode) {
      setError(
        errorCode === "invalid_input"
          ? "That name won't work — try 2 characters or more."
          : "Something went wrong. Try that again.",
      );
      return;
    }
    setStep("compose");
  }

  async function submitVouch(event: React.FormEvent) {
    event.preventDefault();
    if (busy || tradeId === null) return;
    setBusy(true);
    setError(null);

    const { data, errorCode } = await invokeFunction<{ created: boolean }>(
      "upsert-vouch",
      {
        trader_id: trader.trader_id,
        trade_id: tradeId,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        invite_token: token,
        source: "weblink",
      },
    );
    setBusy(false);

    if (errorCode) {
      setError(
        errorCode === "vouch_locked"
          ? "This vouch was removed by the VOUCH team and can't be re-posted."
          : errorCode === "rate_limited"
            ? "New accounts can give up to 5 vouches in their first day."
            : "That didn't go through. Try again in a moment.",
      );
      return;
    }

    setCreated(data?.created ?? true);
    setStep("done");
  }

  // ------------------------------------------------------------------ views --

  if (step === "phone") {
    return (
      <form onSubmit={submitPhone} className="flex flex-col gap-3">
        <label htmlFor="phone" className="text-base font-medium">
          Your number
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          autoFocus
          placeholder="555-1234"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value)}
          className={FIELD}
        />
        <p className={HELPER}>
          Trinidad numbers work as-is — include the country code for anything
          else.
        </p>
        <Err>{error}</Err>
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "Sending…" : "Continue"}
        </button>
      </form>
    );
  }

  if (step === "otp") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) verify(code);
        }}
        className="flex flex-col gap-3"
      >
        <label htmlFor="code" className="text-base font-medium">
          Enter the 6-digit code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(digits);
            // Auto-submit: nobody should have to hunt for a button here.
            if (digits.length === 6) verify(digits);
          }}
          className={`${FIELD} tracking-[0.4em]`}
        />
        <p className={HELPER}>Sent to {e164}.</p>
        <Err>{error}</Err>
        <button type="submit" disabled={busy || code.length < 6} className={BUTTON}>
          {busy ? "Checking…" : "Verify"}
        </button>
        <button
          type="button"
          onClick={resend}
          disabled={busy || cooldown > 0}
          className="text-sm text-zinc-600 underline underline-offset-4 disabled:no-underline disabled:opacity-60 dark:text-zinc-400"
        >
          {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
        </button>
      </form>
    );
  }

  if (step === "name") {
    return (
      <form onSubmit={submitName} className="flex flex-col gap-3">
        <label htmlFor="name" className="text-base font-medium">
          What&rsquo;s your name?
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          autoFocus
          placeholder="Keisha Mohammed"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
        <p className={HELPER}>
          {traderFirstName} will see this on your vouch.
        </p>
        <Err>{error}</Err>
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </form>
    );
  }

  if (step === "compose") {
    const single = trader.trades.length === 1;
    return (
      <form onSubmit={submitVouch} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-base font-medium">
            {single ? "What you're vouching for" : "What did they do for you?"}
          </span>
          {trader.trades.length === 0 ? (
            <p className={HELPER}>
              {traderFirstName} hasn&rsquo;t listed a service yet.
            </p>
          ) : single ? (
            <span className="w-fit rounded-full border border-black px-4 py-2 text-base dark:border-zinc-50">
              {trader.trades[0].name}
            </span>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {trader.trades.map((trade) => {
                const selected = trade.id === tradeId;
                return (
                  <li key={trade.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setTradeId(trade.id)}
                      className={
                        selected
                          ? "rounded-full border border-black bg-black px-4 py-3 text-base text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-black"
                          : "rounded-full border border-zinc-300 px-4 py-3 text-base text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                      }
                    >
                      {trade.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="comment" className="text-base font-medium">
            Say a word about them{" "}
            <span className="font-normal text-zinc-500">(optional)</span>
          </label>
          <textarea
            id="comment"
            name="comment"
            rows={4}
            maxLength={MAX_COMMENT}
            placeholder="Turned up when he said he would."
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
            className="w-full rounded-lg border border-zinc-300 bg-white p-4 text-lg text-black outline-none placeholder:text-zinc-400 focus:border-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:focus:border-zinc-400"
          />
          <p className={`${HELPER} text-right`}>
            {comment.length}/{MAX_COMMENT}
          </p>
        </div>

        <Err>{error}</Err>
        <button
          type="submit"
          disabled={busy || tradeId === null}
          className={BUTTON}
        >
          {busy ? "Posting…" : `Vouch for ${traderFirstName}`}
        </button>
      </form>
    );
  }

  // step === "done"
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold tracking-tight">
        {created ? `Done. ${traderFirstName} thanks you.` : "Your vouch is updated."}
      </h2>
      <div className="flex flex-col gap-3">
        <Link
          href={referralCode ? `/join?code=${encodeURIComponent(referralCode)}` : "/join"}
          className="flex h-14 items-center justify-center rounded-lg bg-black px-4 text-center text-base font-medium text-white dark:bg-zinc-50 dark:text-black"
        >
          Do you offer a service? Join free — 6 months on us
        </Link>
        <Link
          href="/"
          className="flex h-14 items-center justify-center rounded-lg border border-zinc-300 px-4 text-center text-base font-medium text-black dark:border-zinc-700 dark:text-zinc-50"
        >
          Find vouched traders near you
        </Link>
      </div>
    </div>
  );
}

"use client";

/**
 * Shared chrome for the admin dashboard (spec M9). Deliberately tiny and
 * hand-rolled — same monochrome zinc/black/white vocabulary as the /v
 * stepper, no component library, no icon set. Every admin page imports its
 * fields, buttons and time formatting from here so the five screens can't
 * drift apart.
 */
import { useEffect, useState } from "react";

export const FIELD =
  "h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base text-black outline-none placeholder:text-zinc-400 focus:border-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50 dark:focus:border-zinc-400";

export const BUTTON =
  "h-11 rounded-lg bg-black px-4 text-base font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-black";

/** Secondary action: same weight, no fill. */
export const GHOST =
  "h-11 rounded-lg border border-zinc-300 px-4 text-base text-black disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-50";

/**
 * Destructive actions are outlined red, never filled — a filled red button
 * next to a filled black one invites the wrong tap on a phone.
 */
export const DANGER =
  "h-11 rounded-lg border border-red-600 px-4 text-base font-medium text-red-700 disabled:opacity-40 dark:border-red-500 dark:text-red-400";

export const HELPER = "text-sm text-zinc-500 dark:text-zinc-400";

export const CARD =
  "rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950";

export function Err({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}

export function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count?: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold tracking-tight">
        {title}
        {count !== undefined && (
          <span className="ml-2 font-normal text-zinc-500">{count}</span>
        )}
      </h2>
      {hint && <p className={HELPER}>{hint}</p>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-zinc-300 px-5 py-8 text-center text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </p>
  );
}

/** Small monochrome badge — status pills, counts, "suspended". */
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "alert";
}) {
  const skin =
    tone === "alert"
      ? "border-red-600 text-red-700 dark:border-red-500 dark:text-red-400"
      : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-xs ${skin}`}>
      {children}
    </span>
  );
}

const ARM_TIMEOUT_MS = 5000;

/**
 * The two-tap pattern for anything that changes somebody else's account: the
 * first tap arms the button and relabels it, the second fires. Arming decays
 * after 5s so a stray tap can't sit primed while the admin scrolls away.
 */
export function ConfirmButton({
  label,
  onConfirm,
  disabled = false,
  className = DANGER,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={armed}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
      }}
      className={className}
    >
      {armed ? "Tap again to confirm" : label}
    </button>
  );
}

/** "3 days ago" — flag age and audit recency are always relative here. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** Dates the admin might read out loud (joined, free until) stay absolute. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

/** Audit and flag rows carry raw uuids; show enough to match, not all 36. */
export function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

/** snake_case action / reason codes read as prose in the UI. */
export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

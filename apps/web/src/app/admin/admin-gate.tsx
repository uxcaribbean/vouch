"use client";

/**
 * The gate in front of every admin screen (spec M9 "Admin UI lives in
 * apps/web /admin (role-gated)").
 *
 * Two facts have to be true before a single child renders: there is a
 * session, and that session's `users` row says role='admin'. The role check
 * is a client read on purpose — RLS only ever returns the caller's own row,
 * so an attacker editing the answer in devtools gains nothing: every action
 * behind this gate is an Edge Function (admin-action / admin-lookup) or a
 * SECURITY DEFINER rpc that re-checks `is_admin()` server-side. This gate is
 * a courtesy to the human, not the security boundary.
 *
 * Sign-in is the same phone → OTP as the /v stepper, compacted: no name
 * step (an admin already has an account) and no resend timer worth a whole
 * state machine.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { normalizePhone } from "@vouch/shared";
import { supabase } from "@/lib/supabase";
import { BUTTON, Err, FIELD, GHOST, HELPER } from "./ui";

type Admin = { id: string; displayName: string };

const AdminContext = createContext<Admin | null>(null);

/** The signed-in admin, for pages that want to name them. */
export function useAdmin(): Admin {
  const admin = useContext(AdminContext);
  if (!admin) throw new Error("useAdmin() used outside <AdminGate>");
  return admin;
}

const NAV = [
  { href: "/admin", label: "Flags" },
  { href: "/admin/taxonomy", label: "Taxonomy" },
  { href: "/admin/lookup", label: "Lookup" },
  { href: "/admin/rings", label: "Rings" },
  // M11 ships this page; the link lives here so the nav stays one list.
  { href: "/admin/metrics", label: "Metrics" },
];

type Gate =
  | { state: "loading" }
  | { state: "signed_out" }
  | { state: "denied" }
  | { state: "ok"; admin: Admin };

export function AdminGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>({ state: "loading" });

  const check = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setGate({ state: "signed_out" });
      return;
    }
    const { data: row } = await supabase
      .from("users")
      .select("id, display_name, role, suspended_at")
      .eq("id", session.user.id)
      .maybeSingle();
    if (!row || row.role !== "admin" || row.suspended_at) {
      setGate({ state: "denied" });
      return;
    }
    setGate({ state: "ok", admin: { id: row.id, displayName: row.display_name } });
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function signOut() {
    await supabase.auth.signOut();
    setGate({ state: "signed_out" });
  }

  if (gate.state === "loading") return <Shell>{null}</Shell>;

  if (gate.state === "signed_out") {
    return (
      <Shell>
        <SignIn onSignedIn={check} />
      </Shell>
    );
  }

  if (gate.state === "denied") {
    return (
      <Shell>
        <div className="flex flex-col items-start gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            This area is for VOUCH admins.
          </h1>
          <p className={HELPER}>
            You&rsquo;re signed in, but this account doesn&rsquo;t have admin
            access.
          </p>
          <button type="button" onClick={signOut} className={GHOST}>
            Sign out
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <div className="min-h-dvh bg-zinc-50 font-sans text-black dark:bg-black dark:text-zinc-50">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-lg font-semibold tracking-tight">
              VOUCH admin
            </span>
            <p className={HELPER}>
              Signed in as {gate.admin.displayName} ·{" "}
              <button
                type="button"
                onClick={signOut}
                className="underline underline-offset-4 hover:no-underline"
              >
                Sign out
              </button>
            </p>
          </div>
          <Nav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-5 py-8">
        <AdminContext.Provider value={gate.admin}>
          {children}
        </AdminContext.Provider>
      </main>
    </div>
  );
}

function Nav() {
  const pathname = usePathname();
  return (
    <nav>
      <ul className="flex flex-wrap gap-2">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded-full border border-black bg-black px-4 py-2 text-sm text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-black"
                    : "rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Centred single-column frame for the pre-gate states. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-zinc-50 px-5 py-10 font-sans text-black dark:bg-black dark:text-zinc-50">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same guard as the /v stepper: auto-submit must not double-fire.
  const verifying = useRef(false);

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
    const { error: otpError } = await supabase.auth.signInWithOtp({
      phone: normalized,
    });
    setBusy(false);
    if (otpError) {
      setError("We couldn't send that code. Try again in a moment.");
      return;
    }
    setE164(normalized);
    setCode("");
    setStep("otp");
  }

  async function verify(sixDigits: string) {
    if (!e164 || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone: e164,
      token: sixDigits,
      type: "sms",
    });
    if (verifyError) {
      setError("That code didn't work. Check it and try again.");
      setCode("");
      setBusy(false);
      verifying.current = false;
      return;
    }
    await onSignedIn();
    verifying.current = false;
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">VOUCH admin</h1>
        <p className={HELPER}>Sign in with the number on your admin account.</p>
      </div>

      {step === "phone" ? (
        <form onSubmit={submitPhone} className="flex flex-col gap-3">
          <label htmlFor="admin-phone" className="text-base font-medium">
            Your number
          </label>
          <input
            id="admin-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="555-0002"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            className={FIELD}
          />
          <Err>{error}</Err>
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) void verify(code);
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="admin-code" className="text-base font-medium">
            Enter the 6-digit code
          </label>
          <input
            id="admin-code"
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
              if (digits.length === 6) void verify(digits);
            }}
            className={`${FIELD} tracking-[0.4em]`}
          />
          <p className={HELPER}>Sent to {e164}.</p>
          <Err>{error}</Err>
          <button
            type="submit"
            disabled={busy || code.length < 6}
            className={BUTTON}
          >
            {busy ? "Checking…" : "Verify"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("phone");
              setError(null);
            }}
            className="text-sm text-zinc-600 underline underline-offset-4 dark:text-zinc-400"
          >
            Use a different number
          </button>
        </form>
      )}
    </div>
  );
}

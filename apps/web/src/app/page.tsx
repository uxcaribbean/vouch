export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-zinc-50 px-6 font-sans dark:bg-black">
      <main className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
        <h1 className="text-5xl font-semibold tracking-tight text-black dark:text-zinc-50">
          VOUCH
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Trades &amp; services your own people vouch for. Trinidad first.
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          The no-install vouch flow lives here soon: <code>/v/&lt;token&gt;</code> (M7),
          plus the admin dashboard (M9).
        </p>
      </main>
    </div>
  );
}

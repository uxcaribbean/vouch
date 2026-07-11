/**
 * delete-account — spec M1.4, required for app-store approval.
 * Soft-deletes the profile (anonymized, so vouch counts stay intact),
 * hard-deletes contact fingerprints and avatar files, then hard-deletes
 * the auth record which revokes all sessions and frees the phone number.
 */
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const db = serviceClient();

  await db.from("events").insert({ user_id: user.id, name: "account_deleted" });

  // Anonymize: PII gone, row kept so existing vouches still count.
  const { error: anonError } = await db
    .from("users")
    .update({
      display_name: "A former member",
      avatar_url: null,
      phone_e164: null,
      phone_hash: null,
      contact_sync_enabled: false,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (anonError) {
    console.error("anonymize failed", anonError);
    return json({ error: "delete_failed" }, 500);
  }

  const { error: hashError } = await db
    .from("contact_hashes")
    .delete()
    .eq("owner_user_id", user.id);
  if (hashError) {
    console.error("contact hash purge failed", hashError);
    return json({ error: "delete_failed" }, 500);
  }

  const { data: avatarFiles } = await db.storage.from("avatars").list(user.id);
  if (avatarFiles?.length) {
    await db.storage
      .from("avatars")
      .remove(avatarFiles.map((f) => `${user.id}/${f.name}`));
  }

  const { error: authError } = await db.auth.admin.deleteUser(user.id);
  if (authError) {
    console.error("auth delete failed", authError);
    return json({ error: "delete_failed" }, 500);
  }

  return json({ deleted: true });
});

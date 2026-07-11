import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  hashContactList,
  hashPhone,
  normalizeAndHash,
  normalizePhone,
} from "../src/phone";
import {
  generateReferralCode,
  isValidReferralCode,
  REFERRAL_ALPHABET,
} from "../src/referral";

const TT = "+18685551234";

describe("normalizePhone — Trinidad formats (spec §2)", () => {
  it.each([
    ["868-555-1234", TT],
    ["5551234", TT],
    ["+18685551234", TT],
    ["18685551234", TT],
    ["8685551234", TT],
    ["(868) 555-1234", TT],
    [" 868 555 1234 ", TT],
    ["868.555.1234", TT],
    ["1 (868) 555-1234", TT],
    ["555-1234", TT], // bare subscriber number with dash
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe("normalizePhone — foreign numbers keep their country code", () => {
  it("keeps a UK mobile as +44", () => {
    expect(normalizePhone("+44 7911 123456")).toBe("+447911123456");
  });

  it("handles the NANP international dial prefix 011", () => {
    expect(normalizePhone("011 44 7911 123456")).toBe("+447911123456");
  });

  it("resolves other NANP territories instead of forcing +1868", () => {
    // Dominican Republic number saved without "+" in a Trinidadian phone
    expect(normalizePhone("809-555-1234")).toBe("+18095551234");
  });

  it("never applies the 868 fallback to inputs that carry a +", () => {
    expect(normalizePhone("+5551234")).toBeNull();
  });
});

describe("normalizePhone — invalid input returns null", () => {
  it.each([
    [""],
    ["   "],
    ["abc"],
    ["not a phone"],
    ["123"],
    ["86855512"], // 8 digits: too short for TT, too long for fallback
    ["55512345"], // 8 digits: fallback only applies to exactly 7
    ["+1868555123"], // subscriber number too short
    ["+999123456789"], // nonexistent country code
  ])("%s → null", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe("hashPhone — the storage contract", () => {
  it("is sha256 of the full E.164 string incl. '+', lowercase hex", () => {
    const expected = createHash("sha256").update(TT, "utf8").digest("hex");
    expect(hashPhone(TT)).toBe(expected);
  });

  it("emits 64 lowercase hex chars, deterministically", () => {
    const hash = hashPhone(TT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone(TT)).toBe(hash);
  });

  it("the '+' is part of the hashed input", () => {
    expect(hashPhone("+18685551234")).not.toBe(hashPhone("18685551234"));
  });
});

describe("normalizeAndHash — every written form of a number matches", () => {
  it("all equivalent TT formats produce one identical hash", () => {
    const forms = ["868-555-1234", "5551234", "+18685551234", "18685551234"];
    const hashes = new Set(
      forms.map((form) => normalizeAndHash(form)?.hash),
    );
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(hashPhone(TT));
  });

  it("returns null for invalid input", () => {
    expect(normalizeAndHash("nope")).toBeNull();
  });
});

describe("hashContactList — contact sync helper", () => {
  it("dedupes equivalent formats and drops invalid entries", () => {
    const result = hashContactList([
      "868-555-1234",
      "5551234", // same number, different form
      "+447911123456",
      "garbage",
      "",
    ]);
    expect(result).toHaveLength(2);
    expect(result).toContain(hashPhone(TT));
    expect(result).toContain(hashPhone("+447911123456"));
  });
});

describe("referral codes", () => {
  it("generates 6-char codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateReferralCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(REFERRAL_ALPHABET).toContain(ch);
      expect(isValidReferralCode(code)).toBe(true);
    }
  });

  it("validates case-insensitively and rejects ambiguous chars", () => {
    expect(isValidReferralCode("jam4kq")).toBe(true);
    expect(isValidReferralCode(" JAM4KQ ")).toBe(true);
    expect(isValidReferralCode("JAM4K0")).toBe(false); // zero excluded
    expect(isValidReferralCode("JAM4K")).toBe(false); // too short
    expect(isValidReferralCode("JAM4KQX")).toBe(false); // too long
  });
});

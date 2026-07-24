"use client";
import { useEffect, useState } from "react";

/**
 * Is the visitor Arabic? Starts false so server render and client hydration
 * match (no hydration mismatch), then resolves after mount: ?lang= URL param
 * (persisted so the choice survives navigation), else the stored choice
 * (ra_lang / ra_lang_choice written by the landing toggle).
 */
export default function useLang(): boolean {
  const [ar, setAr] = useState(false);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("lang");
      if (q === "ar") { localStorage.setItem("ra_lang", "ar"); setAr(true); return; }
      if (q === "en") { localStorage.setItem("ra_lang", "en"); setAr(false); return; }
      setAr((localStorage.getItem("ra_lang") || localStorage.getItem("ra_lang_choice") || "en") === "ar");
    } catch {
      /* noop */
    }
  }, []);
  return ar;
}

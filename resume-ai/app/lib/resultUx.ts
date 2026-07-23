"use client";
import { useEffect, useState } from "react";

/**
 * When a results view is open, pressing Back should return to the scan form —
 * not exit the whole site (the results page pushes no history state on its own).
 * Pushes one history entry while `active` and clears the result on popstate.
 */
export function useBackToForm(active: boolean, onBack: () => void) {
  useEffect(() => {
    if (!active) return;
    window.history.pushState({ raResult: true }, "");
    const onPop = () => onBack();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // onBack is recreated each render; we only want to (re)arm when `active`
    // flips, so intentionally omit it from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/**
 * Count-up toward `target` over ~900ms (easeOutCubic) so the score reveal feels
 * earned instead of popping in statically. Returns the current display value.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!target) { setValue(0); return; }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

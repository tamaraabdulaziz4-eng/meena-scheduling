"use client";
/**
 * رابط — THE ONE ORB. It lives here, in a provider mounted once in the root
 * layout, so it NEVER unmounts across navigation. Every route only describes a
 * *scene* (mood + position + adornments) via `useOrbScene`; the same physical
 * orb then flies to that scene with a spring. The visitor never sees it reload
 * or disappear — رابط carries them between worlds.
 *
 * Law 1 (continuity): one mounted orb, always. Law 2 (emission): content is
 * born around it. Law 3 (moods): greeting → interview → thinking → weaving →
 * score → golden → success → library → gate → lost — one living entity.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring } from "framer-motion";
import AiOrb, { type OrbState } from "../AiOrb";
import AmbientField from "./AmbientField";

/**
 * Route crossfade. OPACITY ONLY — never y/scale/transform on this wrapper: a
 * transform on an ancestor collapses `position:fixed` descendants (the global
 * orb, the landing dock) into it. Every route dissolves into the next so the
 * site reads as one continuous surface rather than a stack of page loads.
 */
function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? undefined : { opacity: 0 }}
        transition={{ duration: reduce ? 0 : 0.28, ease: "easeInOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

export interface OrbScene {
  visible: boolean;
  mood: OrbState;
  top: string;        // vh or px from the top
  left?: string;      // horizontal anchor (default "50%" = centered)
  size: number;
  progress: number;   // 0–100 ring around the orb (0 = none)
  rings: boolean;     // full-screen aurora pulse rings (thinking)
  badge: string | null; // a glyph layered on the orb (e.g. 🔒 / 🔓)
  radio: boolean;     // radio-pulse broadcast (magic link sent)
  z: number;
}
const DEFAULT: OrbScene = { visible: false, mood: "idle", top: "40vh", left: "50%", size: 120, progress: 0, rings: false, badge: null, radio: false, z: 30 };

interface Ctx { setScene: (s: Partial<OrbScene> | null) => void }
const OrbCtx = createContext<Ctx>({ setScene: () => {} });

/** Describe the orb scene for the current route. Pass null / omit to hide it. */
export function useOrbScene(scene: Partial<OrbScene> | null, deps: unknown[] = []) {
  const { setScene } = useContext(OrbCtx);
  useEffect(() => {
    setScene(scene);
    return () => setScene({ visible: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function OrbProvider({ children }: { children: React.ReactNode }) {
  const [scene, setSceneState] = useState<OrbScene>(DEFAULT);
  const reduce = useReducedMotion();
  // Coalesce the unmount-hide of an outgoing page with the mount-set of the
  // incoming one, so a route change never blinks the orb off then on.
  const raf = useRef<number | null>(null);
  const setScene = useMemo<Ctx["setScene"]>(() => (s) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setSceneState((prev) => (s ? { ...prev, ...s } : { ...DEFAULT, visible: false })));
  }, []);
  const ctx = useMemo(() => ({ setScene }), [setScene]);

  // The orb PHYSICALLY grows/shrinks between scenes (hero 380px ↔ mini 44px)
  // — a spring on the size itself, not an instant jump. Signature move.
  const sizeMv = useMotionValue(scene.size);
  const sizeSpring = useSpring(sizeMv, { stiffness: 110, damping: 17 });
  const [displaySize, setDisplaySize] = useState(scene.size);
  useEffect(() => { sizeMv.set(scene.size); }, [scene.size, sizeMv]);
  useMotionValueEvent(sizeSpring, "change", (v) => setDisplaySize(Math.round(v)));

  const ring = 2 * Math.PI * 44;

  return (
    <OrbCtx.Provider value={ctx}>
      {/* the living background — beneath every page, reacting to everything */}
      <AmbientField mood={scene.mood} active={scene.visible} />
      <PageTransition>{children}</PageTransition>
      {scene.visible && (
        <motion.div
          className="pointer-events-none fixed"
          style={{ zIndex: scene.z }}
          initial={false}
          animate={{ top: scene.top, left: scene.left ?? "50%", x: "-50%", opacity: 1 }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 18 }}
        >
          <div className={`relative flex items-center justify-center ${scene.radio ? "radio-pulse" : ""}`} style={{ width: displaySize, height: displaySize }}>
            {scene.rings && !reduce && (<><span className="pulse-ring r1" /><span className="pulse-ring r2" /><span className="pulse-ring r3" /><span className="pulse-ring r4" /></>)}
            {scene.progress > 0 && (
              <svg className="absolute" width={displaySize + 16} height={displaySize + 16} style={{ transform: "rotate(-90deg)" }}>
                <defs>
                  <linearGradient id="orbProgressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#8b5cf6" />
                    <stop offset="55%" stopColor="#ec4899" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                </defs>
                <circle cx={(displaySize + 16) / 2} cy={(displaySize + 16) / 2} r="44" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                <circle cx={(displaySize + 16) / 2} cy={(displaySize + 16) / 2} r="44" fill="none" stroke="url(#orbProgressGrad)" strokeWidth="3" strokeLinecap="round" strokeDasharray={ring} strokeDashoffset={ring * (1 - scene.progress / 100)} style={{ transition: "stroke-dashoffset .6s ease" }} />
              </svg>
            )}
            <AiOrb size={displaySize} state={scene.mood} />
            {scene.badge && <span className="absolute" style={{ fontSize: displaySize * 0.3 }}>{scene.badge}</span>}
          </div>
        </motion.div>
      )}
    </OrbCtx.Provider>
  );
}

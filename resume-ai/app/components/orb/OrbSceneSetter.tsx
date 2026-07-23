"use client";
import { useOrbScene, type OrbScene } from "./OrbProvider";

/** Lets a server component set the global orb scene by rendering this child. */
export default function OrbSceneSetter(scene: Partial<OrbScene>) {
  useOrbScene(scene, [JSON.stringify(scene)]);
  return null;
}

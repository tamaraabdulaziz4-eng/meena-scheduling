"use client";
/**
 * Floating aurora blobs — the ambient background of the COSMOS (dark) world.
 * Two-three soft color orbs drifting on a slow transform loop. Pure CSS, GPU
 * (transform/opacity only), reduced-motion safe (the .aurora-bg rules already
 * kill the drift). Reused across dark pages so every screen shares one sky.
 */
export default function AuroraBlobs({ className = "" }: { className?: string }) {
  return <div className={`aurora-bg ${className}`} aria-hidden />;
}

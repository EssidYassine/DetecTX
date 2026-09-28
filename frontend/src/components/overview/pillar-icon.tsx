import type { PillarKey } from "@/lib/api";
import { PILLAR_ICON } from "@/lib/posture";

export function PillarIcon({ pillar, className = "" }: { pillar: PillarKey; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PILLAR_ICON[pillar]} />
    </svg>
  );
}

import {
  m,
  type TargetAndTransition,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
} from 'motion/react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

export type FunnyBunnyState = 'idle' | 'working';

interface FunnyBunnyProps {
  state?: FunnyBunnyState;
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

/** How high the bunny hops, in viewBox units (the viewBox is 64 wide). */
const HOP_HEIGHT = 10;
/** Body speed (viewBox units / s) that counts as "fast" for the ears and the stretch. */
const FAST = 70;

const HOP: TargetAndTransition = {
  y: [0, -HOP_HEIGHT, 0],
  transition: {
    duration: 0.7,
    // Fast take-off, slow at the top, fast fall: reads as gravity.
    ease: ['easeOut', 'easeIn'],
    repeat: Infinity,
  },
};
const REST: TargetAndTransition = {
  y: 0,
  transition: { type: 'spring', bounce: 0.5, duration: 0.6 },
};

/**
 * The funny mascot. Only the hop is animated by hand; everything else follows
 * from it through springs: the ears trail the body's speed and the body
 * stretches while moving and squashes when it stops. So changing the hop (or
 * the state) never means re-timing the ears or the squash.
 */
export function FunnyBunny({ state = 'idle', size = 24, className }: FunnyBunnyProps) {
  const reduceMotion = useReducedMotion();
  const maskId = `funny-bunny-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;

  const y = useMotionValue(0);
  const speed = useVelocity(y);

  // Ears: lean against the motion, then settle with a spring wobble.
  const earLean = useSpring(useTransform(speed, [-FAST, FAST], [-18, 18]), {
    stiffness: 260,
    damping: 9,
  });
  const leftEar = useTransform(earLean, (lean) => -8 + lean);
  const rightEar = useTransform(earLean, (lean) => 8 - lean);

  // Squash & stretch: taller while moving; the spring overshoots into a squash on landing.
  const stretch = useSpring(
    useTransform(speed, (v) => 1 + Math.min(Math.abs(v) / FAST, 1) * 0.08),
    { stiffness: 500, damping: 12 },
  );
  const squeeze = useTransform(stretch, (s) => 2 - s);

  // Shadow shrinks while airborne.
  const shadowScale = useTransform(y, [-HOP_HEIGHT, 0], [0.6, 1]);
  const shadowOpacity = useTransform(y, [-HOP_HEIGHT, 0], [0.08, 0.18]);

  const hopping = state === 'working' && !reduceMotion;

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={state === 'working' ? 'funny is working' : 'funny'}
      data-testid="funny-bunny"
      data-state={state}
      className={cn('shrink-0 overflow-visible', className)}
    >
      <defs>
        {/* Luminance mask (white keeps, black cuts): eyes and nose are holes, so the background shows through on any theme. */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="currentColor" className="text-white" />
          <m.g
            fill="currentColor"
            className="text-black"
            style={{ originX: 0.5, originY: 0.5 }}
            animate={reduceMotion ? undefined : { scaleY: [1, 0.1, 1] }}
            transition={{ duration: 0.2, repeat: Infinity, repeatDelay: 3 }}
          >
            <rect x="20" y="36" width="6" height="10" rx="3" />
            <rect x="38" y="36" width="6" height="10" rx="3" />
          </m.g>
          <rect
            x="30"
            y="48"
            width="4"
            height="3"
            rx="1.5"
            fill="currentColor"
            className="text-black"
          />
        </mask>
      </defs>

      <m.ellipse
        cx="32"
        cy="61"
        rx="18"
        ry="2.5"
        fill="currentColor"
        style={{ scaleX: shadowScale, opacity: shadowOpacity, originX: 0.5 }}
      />
      <m.g
        fill="currentColor"
        style={{ y, scaleY: stretch, scaleX: squeeze, originX: 0.5, originY: 1 }}
        animate={hopping ? HOP : REST}
      >
        <m.rect
          x="16"
          y="4"
          width="10"
          height="28"
          rx="5"
          style={{ rotate: leftEar, originX: 0.5, originY: 1 }}
        />
        <m.rect
          x="38"
          y="4"
          width="10"
          height="28"
          rx="5"
          style={{ rotate: rightEar, originX: 0.5, originY: 1 }}
        />
        <rect x="9" y="24" width="46" height="34" rx="17" mask={`url(#${maskId})`} />
      </m.g>
    </svg>
  );
}

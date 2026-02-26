import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useState, useEffect } from 'react';

import { cn } from '@/lib/utils';

const D4C_FRAMES = ['🐇', '🌀', '🐰', '⭐'] as const;
const D4C_INTERVAL = 1800;

const D4C_ANIMATIONS: Record<string, { initial: object; animate: object; exit: object }> = {
  '🐇': {
    initial: { y: -14, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -14, opacity: 0 },
  },
  '🌀': {
    initial: { rotate: -180, scale: 0.3, opacity: 0 },
    animate: { rotate: 0, scale: 1, opacity: 1 },
    exit: { rotate: 180, scale: 0.3, opacity: 0 },
  },
  '🐰': {
    initial: { y: 14, opacity: 0, scale: 0.8 },
    animate: { y: 0, opacity: 1, scale: 1 },
    exit: { y: 14, opacity: 0, scale: 0.8 },
  },
  '⭐': {
    initial: { scale: 0, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0, opacity: 0 },
  },
};

export function D4CAnimation({ size = 'default' }: { size?: 'default' | 'sm' }) {
  const [frame, setFrame] = useState(0);
  const prefersReducedMotion = useReducedMotion();
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % D4C_FRAMES.length), D4C_INTERVAL);
    return () => clearInterval(id);
  }, []);
  const emoji = D4C_FRAMES[frame];
  const anim = D4C_ANIMATIONS[emoji];
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center overflow-hidden leading-none',
        size === 'sm' ? 'w-4 text-xs' : 'w-5 text-base',
      )}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={emoji + frame}
          initial={prefersReducedMotion ? false : anim.initial}
          animate={anim.animate}
          exit={prefersReducedMotion ? undefined : anim.exit}
          transition={{ duration: 0.75, ease: 'easeOut' }}
          className="inline-block"
        >
          {emoji}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

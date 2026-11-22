import type { Meta, StoryObj } from '@storybook/react-vite';
import { domAnimation, LazyMotion } from 'motion/react';
import { useState } from 'react';

import { FunnyBunny, type FunnyBunnyState } from '@/components/FunnyBunny';
import { Button } from '@/components/ui/button';

const meta = {
  title: 'Components/FunnyBunny',
  component: FunnyBunny,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    // The app provides this in main.tsx; `m.*` components need it to animate.
    (Story) => (
      <LazyMotion features={domAnimation}>
        <Story />
      </LazyMotion>
    ),
  ],
  argTypes: {
    state: { control: 'select', options: ['idle', 'working'] },
    size: { control: { type: 'range', min: 16, max: 160, step: 4 } },
  },
} satisfies Meta<typeof FunnyBunny>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = { args: { state: 'working', size: 96 } };

export const Idle: Story = { args: { state: 'idle', size: 96 } };

/** Toggle the state: the stop is not animated by hand, the springs settle on their own. */
export const ToggleState: Story = {
  render: () => {
    const [state, setState] = useState<FunnyBunnyState>('working');
    return (
      <div className="flex flex-col items-center gap-4">
        <FunnyBunny state={state} size={120} />
        <Button
          size="sm"
          variant="outline"
          data-testid="funny-bunny-toggle"
          onClick={() => setState((s) => (s === 'working' ? 'idle' : 'working'))}
        >
          {state === 'working' ? 'Stop' : 'Start working'}
        </Button>
      </div>
    );
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-6">
      {[16, 24, 48, 96].map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <FunnyBunny state="working" size={size} />
          <span className="text-muted-foreground text-xs">{size}px</span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-sm">
        <FunnyBunny state="working" size={16} />
        Agent is working… (12s)
      </div>
    </div>
  ),
};

/* ---------- Comparison with the pure CSS keyframes version (story only) ---------- */

const CSS_VERSION = `
[data-css-bunny] * { transform-box: fill-box; }
[data-css-bunny] [data-part~="body"] { transform-box: view-box; transform-origin: 32px 58px; animation: cb-hop 1s cubic-bezier(.45,0,.55,1) infinite; }
@keyframes cb-hop {
  0%, 100% { transform: translateY(0) scale(1.08, .92); }
  15% { transform: translateY(0) scale(.94, 1.07); }
  45% { transform: translateY(-10px) scale(1, 1); }
  75% { transform: translateY(-1px) scale(.97, 1.03); }
}
[data-css-bunny] [data-part~="ear"] { transform-origin: 50% 100%; animation: cb-ear-l 1s cubic-bezier(.45,0,.55,1) infinite; animation-delay: -.92s; }
[data-css-bunny] [data-part~="ear-r"] { animation-name: cb-ear-r; }
@keyframes cb-ear-l { 0%,100% { transform: rotate(-8deg); } 20% { transform: rotate(-20deg); } 50% { transform: rotate(-2deg); } }
@keyframes cb-ear-r { 0%,100% { transform: rotate(8deg); } 20% { transform: rotate(20deg); } 50% { transform: rotate(2deg); } }
[data-css-bunny] [data-part~="eyes"] { transform-origin: center; animation: cb-blink 3.2s infinite; }
@keyframes cb-blink { 0%, 88%, 100% { transform: scaleY(1); } 92% { transform: scaleY(.1); } }
[data-css-bunny] [data-part~="shadow"] { transform-origin: center; animation: cb-shadow 1s cubic-bezier(.45,0,.55,1) infinite; }
@keyframes cb-shadow { 0%,15%,100% { transform: scaleX(1); opacity: .18; } 45% { transform: scaleX(.6); opacity: .08; } }
`;

function CssBunny({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} data-css-bunny className="overflow-visible">
      <style>{CSS_VERSION}</style>
      <defs>
        <mask id="css-bunny-face" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="currentColor" className="text-white" />
          <g data-part="eyes" fill="currentColor" className="text-black">
            <rect x="20" y="36" width="6" height="10" rx="3" />
            <rect x="38" y="36" width="6" height="10" rx="3" />
          </g>
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
      <ellipse data-part="shadow" cx="32" cy="61" rx="18" ry="2.5" fill="currentColor" />
      <g data-part="body" fill="currentColor">
        <rect data-part="ear ear-l" x="16" y="4" width="10" height="28" rx="5" />
        <rect data-part="ear ear-r" x="38" y="4" width="10" height="28" rx="5" />
        <rect x="9" y="24" width="46" height="34" rx="17" mask="url(#css-bunny-face)" />
      </g>
    </svg>
  );
}

/** Left: hand-timed CSS keyframes. Right: Motion, one hop + springs. */
export const CssVsMotion: Story = {
  render: () => (
    <div className="flex items-end gap-16">
      <div className="flex flex-col items-center gap-3">
        <CssBunny size={120} />
        <span className="text-muted-foreground text-xs">CSS @keyframes</span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <FunnyBunny state="working" size={120} />
        <span className="text-muted-foreground text-xs">Motion (springs)</span>
      </div>
    </div>
  ),
};

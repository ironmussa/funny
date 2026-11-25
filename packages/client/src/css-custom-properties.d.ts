// CSS custom properties in a `style` prop (`style={{ '--row-height': '24px' }}`).
// shadcn/no-inline-styles allows only custom properties in a style prop: a
// runtime value goes in a variable, and a Tailwind class reads it
// (`h-[var(--row-height)]`).
import 'react';

declare module 'react' {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined;
  }
}

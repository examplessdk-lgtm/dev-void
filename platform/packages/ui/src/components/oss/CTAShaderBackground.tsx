type Variant = 'vite' | 'vitest' | 'rolldown' | 'oxc';

type ColorPalette = Readonly<{
  circle: string;
  dark: string;
  light: string;
  mid: string;
}>;

const palettes: Record<Variant, ColorPalette> = {
  oxc: {
    circle: '#45d3ba',
    dark: '#004347',
    light: '#1BFBDE',
    mid: '#009f9f',
  },
  rolldown: {
    circle: '#e4a458',
    dark: '#502901',
    light: '#ff5602',
    mid: '#bf3f00',
  },
  vite: {
    circle: '#743DA9',
    dark: '#2E066B',
    light: '#cdb5ea',
    mid: '#6A15DB',
  },
  vitest: {
    circle: '#6CDD60',
    dark: '#013D16',
    light: '#33ffb1',
    mid: '#00c65b',
  },
};

type CTAShaderBackgroundProps = Readonly<{
  variant?: Variant;
}>;

export default function CTAShaderBackground({ variant = 'vite' }: CTAShaderBackgroundProps) {
  const colors = palettes[variant] ?? palettes.vite;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 -z-0 hidden md:block"
      style={{
        background: `radial-gradient(120% 120% at 50% 100%, ${colors.light} 0%, ${colors.mid} 40%, ${colors.dark} 80%)`,
        opacity: 0.9,
      }}
    />
  );
}

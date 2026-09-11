export type IconOption = string | { dark: string; light: string };

export type FooterLink = Readonly<{
  link: string;
  text: string;
}>;

export type FooterColumn = Readonly<{
  items: ReadonlyArray<FooterLink>;
  title: string;
}>;

export type FooterSocialLink = Readonly<{
  icon: string;
  label?: string;
  link: string;
}>;

export type FooterConfig = Readonly<{
  copyright?: string;
  message?: string;
  nav?: ReadonlyArray<FooterColumn>;
  social?: ReadonlyArray<FooterSocialLink>;
}>;

export type BannerConfig = Readonly<{
  icon?: 'vite' | 'vitest' | 'rolldown' | 'oxc' | 'viteplus';
  id: string;
  target?: '_self' | '_blank';
  text: string;
  url: string;
}>;

export type HeroAction = Readonly<{
  link?: string;
  text: string;
  theme?: 'brand' | 'alt';
}>;

export type HeroConfig = Readonly<{
  actions?: ReadonlyArray<HeroAction>;
  image?: {
    alt?: string;
    src?: string;
  };
  tagline?: string;
  text?: string;
}>;

export type FeatureConfig = Readonly<{
  details?: string;
  icon?: string;
  iconify?: string;
  title: string;
}>;

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
  nav?: ReadonlyArray<FooterColumn>;
  social?: ReadonlyArray<FooterSocialLink>;
}>;

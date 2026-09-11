export type Sponsor = Readonly<{
  hasDark?: true;
  img: string;
  name: string;
  url: string;
}>;

export type SponsorSize = 'big' | 'medium' | 'small' | 'avatar';

export type SponsorTier = Readonly<{
  items: ReadonlyArray<Sponsor>;
  size: SponsorSize;
  tier: string;
}>;

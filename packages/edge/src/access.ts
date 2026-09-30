export type ProjectZeroTrustRouting = Readonly<{
  teamDomain: string;
  audiences: ReadonlyArray<Readonly<{ hostname: string; audience: string }>>;
}>;

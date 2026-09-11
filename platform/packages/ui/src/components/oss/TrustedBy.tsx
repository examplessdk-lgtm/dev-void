import LogoGrid from '../shared/LogoGrid.tsx';

type TrustedByLogo =
  | string
  | {
      alt: string;
      darkSrc: string;
      src: string;
    };

type TrustedByProps = Readonly<{
  logos: ReadonlyArray<TrustedByLogo>;
}>;

export default function TrustedBy({ logos }: TrustedByProps) {
  const normalizedLogos = logos.map((logo) =>
    typeof logo === 'string'
      ? {
          alt: logo,
          darkSrc: `/trusted-by/${logo}.svg`,
          src: `/trusted-by/${logo}.svg`,
        }
      : logo,
  );

  return (
    <div className="trusted-by">
      <section className="wrapper wrapper--ticks flex flex-col justify-center gap-5 border-t px-10 py-6 md:py-8">
        <h6 className="text-center md:text-start">
          Trusted by the world&apos;s best software teams
        </h6>
      </section>
      <section className="wrapper wrapper--ticks border-t">
        <LogoGrid logos={normalizedLogos} />
      </section>
    </div>
  );
}

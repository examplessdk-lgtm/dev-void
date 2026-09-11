import type { ReactNode } from 'react';
import voidzeroLogo from '../../assets/logos/voidzero-light.svg';
import type { HeroConfig } from '../../types/theme-config.ts';

type HeroProps = Readonly<{
  background?: string;
  hero?: HeroConfig;
  heroImage?: ReactNode;
}>;

export default function Hero({ background, hero, heroImage }: HeroProps) {
  if (!hero) {
    return null;
  }

  return (
    <div
      className="wrapper wrapper--ticks grid w-full border-nickel bg-primary md:divide-x lg:grid-cols-2"
      data-theme="dark"
    >
      <div className="flex flex-col items-center justify-between gap-20 p-15 text-center sm:p-20 md:items-start md:text-left">
        <div className="flex flex-col items-center gap-5 md:items-start">
          <a
            className="flex items-center gap-2"
            href="https://voidzero.dev"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="font-mono text-xs tracking-wide text-grey uppercase">By</span>
            <img alt="VoidZero" className="h-2.5" src={voidzeroLogo} />
          </a>
          {hero.text ? <h1 className="max-w-[30rem] text-pretty text-white">{hero.text}</h1> : null}
          {hero.tagline ? (
            <p className="max-w-[27rem] text-pretty text-white/70 md:text-lg">{hero.tagline}</p>
          ) : null}
          {hero.actions?.length ? (
            <div className="mt-8 flex flex-col items-center gap-5 min-[410px]:flex-row">
              {hero.actions.map((action) => (
                <a
                  className={
                    action.theme === 'brand' ? 'button button--primary w-fit' : 'button w-fit'
                  }
                  href={action.link}
                  key={action.text}
                  rel={action.link?.startsWith('http') ? 'noopener noreferrer' : undefined}
                  target={action.link?.startsWith('http') ? '_blank' : undefined}
                >
                  {action.theme === 'brand' ? <span>{action.text}</span> : action.text}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div
        className="flex flex-col bg-cover bg-center"
        style={background ? { backgroundImage: `url(${background})` } : undefined}
      >
        <div className="relative flex h-full flex-col justify-center overflow-clip px-10 pb-10 md:pt-10">
          {heroImage ??
            (hero.image?.src ? (
              <img alt={hero.image.alt} className="max-h-[20rem]" src={hero.image.src} />
            ) : null)}
        </div>
      </div>
    </div>
  );
}

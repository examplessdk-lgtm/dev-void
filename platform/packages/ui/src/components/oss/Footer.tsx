import { useThemeContext } from '../../context/ThemeContext.tsx';
import type { FooterConfig } from '../../types/theme-config.ts';
import FooterNav from './FooterNav.tsx';

type FooterProps = Readonly<{
  buttonLink?: string;
  buttonText?: string;
  footer?: FooterConfig;
  heading?: string;
  subheading?: string;
}>;

export default function Footer({
  buttonLink = '/guide/',
  buttonText = 'Get Started',
  footer,
  heading = 'Get Started',
  subheading = 'Prepare for a development environment that can finally keep pace with the speed of your mind.',
}: FooterProps) {
  const { footerBg: backgroundImage } = useThemeContext();

  return (
    <footer className="bg-primary" data-theme="dark">
      <section className="wrapper">
        <div className="relative w-full">
          <img
            alt="Footer background"
            className="absolute inset-0 z-0 h-full w-full object-cover"
            inert
            loading="lazy"
            src={backgroundImage}
          />
          <div className="relative z-10 mx-auto flex w-full flex-col items-center justify-start gap-5 px-5 py-10 sm:w-2xl sm:px-0 md:py-30">
            <h2 className="text-center text-balance text-white drop-shadow-sm/70">{heading}</h2>
            <p className="max-w-md text-center text-balance text-white drop-shadow-sm/70">
              {subheading}
            </p>
            <a className="button button--white mt-5" href={buttonLink}>
              {buttonText}
            </a>
          </div>
        </div>
      </section>
      <FooterNav footer={footer} />
    </footer>
  );
}

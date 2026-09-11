import voidzeroLogo from '../../assets/logos/voidzero-light.svg';
import heroTerminal from '../../assets/vitest/hero-terminal.png';

export default function Hero() {
  return (
    <div className="wrapper wrapper--ticks grid w-full divide-x divide-stroke border-t border-stroke md:grid-cols-2 dark:divide-nickel dark:border-nickel">
      <div className="flex flex-col items-center justify-center p-10 md:items-start">
        <div className="flex max-w-[30rem] flex-col items-center gap-5 text-center md:items-start md:text-left">
          <a
            className="flex items-center gap-2"
            href="https://voidzero.dev"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="font-mono text-xs tracking-wide text-grey uppercase">By</span>
            <img alt="VoidZero" className="h-2.5" src={voidzeroLogo} />
          </a>
          <h1 className="text-pretty">Next Generation Testing Framework</h1>
          <p className="max-w-[25rem] text-lg text-pretty text-grey dark:text-white/70">
            A Vite-native testing framework. It&apos;s fast!
          </p>
          <div className="mt-8 flex items-center gap-5">
            <a className="button button--primary inline-block w-fit" href="/guide/">
              <span>Get Started</span>
            </a>
            <a
              className="button inline-block w-fit"
              href="https://github.com/vitest-dev/vitest"
              rel="noopener noreferrer"
              target="_blank"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </div>
      <div className="flex min-h-[22rem] flex-col sm:min-h-[30rem]">
        <div className="hero-background relative flex h-full flex-col justify-center overflow-clip py-8 pl-6 sm:py-16 sm:pl-16">
          <img alt="Vitest terminal" className="h-full w-full object-contain" src={heroTerminal} />
        </div>
      </div>
    </div>
  );
}

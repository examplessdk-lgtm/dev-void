import vitestIcon from '../../assets/icons/vitest-light.svg';

export default function Intro() {
  return (
    <div className="wrapper wrapper--ticks border-t border-stroke px-5 py-14 sm:px-10 lg:px-20 lg:py-30 dark:border-nickel">
      <div className="flex flex-col gap-5 text-left lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="flex max-w-md flex-col gap-3">
          <div className="flex items-center gap-3">
            <img alt="Vitest icon" className="size-5" src={vitestIcon} />
            <span className="font-mono text-xs font-medium tracking-wide text-grey uppercase">
              Why Vitest
            </span>
          </div>
          <h3 className="max-w-xl text-balance">The Vite Native Test Runner</h3>
          <a
            className="button mt-8 hidden w-fit lg:block"
            href="/guide/why"
            rel="noopener noreferrer"
            target="_blank"
          >
            Learn more
          </a>
        </div>
        <div className="lg:max-w-lg">
          <p className="mb-5 text-pretty">
            <a href="https://vite.dev" rel="noopener noreferrer" target="_blank">
              <code className="mr-1 bg-stroke/60 text-vite outline-none dark:bg-nickel/50">
                Vite
              </code>
            </a>{' '}
            has become the shared foundation for modern web development - but test runners like{' '}
            <a href="https://jestjs.io/" rel="noopener noreferrer" target="_blank">
              <code className="mr-1 bg-stroke/60 text-zest outline-none dark:bg-nickel/50">
                Jest
              </code>
            </a>{' '}
            cannot reuse its resolution and transform pipeline, resulting in duplicated
            configurations and compatibility issues.
          </p>
          <p className="mb-5 text-pretty">
            Vitest was born to solve this problem: by building on top of Vite, Vitest natively
            understands everything you have configured for your Vite app, and the tests just work.
          </p>
          <p className="text-pretty">
            That said, you can totally use Vitest without using Vite - even for backend code.
            It&apos;s a great test runner in its own right.
          </p>
          <a
            className="button mt-8 block w-fit lg:hidden"
            href="/guide/why"
            rel="noopener noreferrer"
            target="_blank"
          >
            Learn more
          </a>
        </div>
      </div>
    </div>
  );
}

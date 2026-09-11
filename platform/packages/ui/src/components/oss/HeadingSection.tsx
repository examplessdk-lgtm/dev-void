type HeadingSectionProps = Readonly<{
  heading: string;
  subheading?: string;
}>;

export default function HeadingSection({ heading, subheading }: HeadingSectionProps) {
  return (
    <section className="wrapper flex flex-col items-center justify-center gap-3 border-t px-5 py-14 text-center sm:px-10 sm:py-28">
      <h2 className="max-w-2xl text-center text-balance">{heading}</h2>
      {subheading ? (
        <p className="max-w-md text-balance text-grey sm:text-pretty dark:text-white/70">
          {subheading}
        </p>
      ) : null}
    </section>
  );
}

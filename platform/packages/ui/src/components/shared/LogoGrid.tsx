import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Logo = Readonly<{
  alt: string;
  darkSrc: string;
  src: string;
}>;

type LogoGridProps = Readonly<{
  logos: ReadonlyArray<Logo>;
}>;

const LOGO_WIDTH = 120;
const LOGO_HEIGHT = 25;
const GAP = 80;

export default function LogoGrid({ logos }: LogoGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [needsScrolling, setNeedsScrolling] = useState(false);

  const contentWidth = useMemo(() => {
    const logoCount = logos.length;
    return logoCount * LOGO_WIDTH + (logoCount - 1) * GAP;
  }, [logos.length]);

  const animationDuration = useMemo(() => logos.length * 3, [logos.length]);

  const checkOverflow = useCallback(() => {
    if (!containerRef.current) {
      return;
    }

    const containerWidth = containerRef.current.offsetWidth;
    setNeedsScrolling(contentWidth > containerWidth);
  }, [contentWidth]);

  useEffect(() => {
    checkOverflow();

    if (!containerRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      checkOverflow();
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [checkOverflow]);

  const gridStyle = useMemo(
    () =>
      ({
        '--logo-animation-duration': `${animationDuration}s`,
        '--logo-count': String(logos.length),
        '--logo-gap': `${GAP}px`,
        '--logo-height': `${LOGO_HEIGHT}px`,
        '--logo-width': `${LOGO_WIDTH}px`,
      }) as React.CSSProperties,
    [animationDuration, logos.length],
  );

  return (
    <div className="logo-grid overflow-hidden py-6" ref={containerRef} style={gridStyle}>
      {needsScrolling ? (
        <div className="scroll-container">
          <div className="scroll-content">
            <div className="flex items-center" style={{ gap: `${GAP}px` }}>
              {logos.map((logo) => (
                <div
                  className="logo-container has-divider relative flex flex-shrink-0 items-center justify-center"
                  key={logo.alt}
                  style={{
                    height: `${LOGO_HEIGHT}px`,
                    width: `${LOGO_WIDTH}px`,
                  }}
                >
                  <img
                    alt={logo.alt}
                    className="hidden max-h-full max-w-full object-contain grayscale dark:block"
                    loading="lazy"
                    src={logo.src}
                  />
                  <img
                    alt={logo.alt}
                    className="block max-h-full max-w-full object-contain grayscale dark:hidden"
                    loading="lazy"
                    src={logo.darkSrc}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center" style={{ gap: `${GAP}px` }}>
              {logos.map((logo) => (
                <div
                  className="logo-container has-divider relative flex flex-shrink-0 items-center justify-center"
                  key={`${logo.alt}-duplicate`}
                  style={{
                    height: `${LOGO_HEIGHT}px`,
                    width: `${LOGO_WIDTH}px`,
                  }}
                >
                  <img
                    alt={logo.alt}
                    className="hidden max-h-full max-w-full object-contain grayscale dark:block"
                    loading="lazy"
                    src={logo.src}
                  />
                  <img
                    alt={logo.alt}
                    className="block max-h-full max-w-full object-contain grayscale dark:hidden"
                    loading="lazy"
                    src={logo.darkSrc}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-evenly">
          {logos.map((logo, index) => (
            <div className="contents" key={logo.alt}>
              <div
                className="logo-container-static flex items-center justify-center"
                style={{
                  height: `${LOGO_HEIGHT}px`,
                  width: `${LOGO_WIDTH}px`,
                }}
              >
                <img
                  alt={logo.alt}
                  className="hidden max-h-full max-w-full object-contain grayscale dark:block"
                  loading="lazy"
                  src={logo.src}
                />
                <img
                  alt={logo.alt}
                  className="block max-h-full max-w-full object-contain grayscale dark:hidden"
                  loading="lazy"
                  src={logo.darkSrc}
                />
              </div>
              {index < logos.length - 1 ? <div className="divider" /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { ReactNode } from 'react';
import viteplusLogoDark from '../../assets/viteplus/logo-dark.svg';
import viteplusLogoLight from '../../assets/viteplus/logo.svg';

type NavItem = Readonly<{
  link: string;
  text: string;
}>;

type VitePlusHeaderProps = Readonly<{
  currentPath?: string;
  nav: ReadonlyArray<NavItem>;
  rightSide?: ReactNode;
}>;

export default function Header({ currentPath, nav, rightSide }: VitePlusHeaderProps) {
  return (
    <header className="wrapper flex items-center justify-between px-6 py-7">
      <div className="flex items-center gap-10">
        <a href="/">
          <img alt="Vite+" className="block h-4 dark:hidden" src={viteplusLogoLight} />
          <img alt="Vite+" className="hidden h-4 dark:block" src={viteplusLogoDark} />
        </a>
        <ul className="nav">
          {nav.map((navItem) => (
            <li key={navItem.link}>
              <a
                className={currentPath === navItem.link ? 'active' : undefined}
                href={navItem.link}
              >
                {navItem.text}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-6">{rightSide}</div>
    </header>
  );
}

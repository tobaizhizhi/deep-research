"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icon";

const links = [
  { href: "/", label: "新建研究", icon: "plus" },
  { href: "/research", label: "研究记录", icon: "history" },
  { href: "/reviews", label: "人工复核", icon: "compass" },
] as const;

export function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="primary-nav" aria-label="主导航">
      {links.map(({ href, label, icon }) => {
        const active =
          href === "/"
            ? pathname === "/"
            : pathname.startsWith(`${href}/`) || pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`nav-link${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={icon} />
            <span>{label}</span>
            {active && <span className="nav-dot" aria-hidden="true" />}
          </Link>
        );
      })}
    </nav>
  );
}

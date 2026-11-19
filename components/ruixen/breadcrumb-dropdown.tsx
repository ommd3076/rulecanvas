"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════
   Breadcrumb Dropdown — Inline-expanding collapsible path.

   Kills the floating dropdown entirely. Instead of hovering
   a trigger to summon a disembodied menu, click the ··· and
   the hidden path segments unfold INLINE — items stagger in
   from the left, each 50ms apart, expanding the breadcrumb
   to reveal the full path. Click again to snap it closed.

   Three distinct paradigms across the breadcrumb family:
     • separator: hover affects OTHER items      (cascade)
     • icon:      a HIGHLIGHT slides to target   (pill)
     • dropdown:  HIDDEN CONTENT unfolds in place (expand)

   The trigger icon morphs between three dots (collapsed)
   and a dash (expanded) with a scale + rotate crossfade.

   Curve: cubic-bezier(0.0, 0.0, 0.2, 1) — Material
   standard deceleration. No spring overshoot — the stagger
   choreography is the motion interest, not the curve.
   ═══════════════════════════════════════════════════════════ */

interface BreadcrumbDropdownItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface BreadcrumbDropdownProps {
  items: BreadcrumbDropdownItem[];
  maxVisible?: number;
  className?: string;
}

export function BreadcrumbDropdown({
  items,
  maxVisible = 3,
  className,
}: BreadcrumbDropdownProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [itemVisible, setItemVisible] = React.useState<boolean[]>([]);
  const staggerTimers = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  const shouldCollapse = items.length > maxVisible;
  const hiddenItems = shouldCollapse
    ? items.slice(1, items.length - (maxVisible - 2))
    : [];
  const visibleEnd = shouldCollapse
    ? items.slice(items.length - (maxVisible - 2))
    : items.slice(1);
  const hiddenCount = hiddenItems.length;

  const toggle = React.useCallback(() => {
    staggerTimers.current.forEach(clearTimeout);
    staggerTimers.current = [];

    if (!expanded) {
      setExpanded(true);
      setItemVisible(new Array(hiddenCount).fill(false));
      for (let i = 0; i < hiddenCount; i++) {
        const timer = setTimeout(() => {
          setItemVisible((prev) => {
            const next = [...prev];
            next[i] = true;
            return next;
          });
        }, i * 50);
        staggerTimers.current.push(timer);
      }
    } else {
      setItemVisible([]);
      setExpanded(false);
    }
  }, [expanded, hiddenCount]);

  React.useEffect(() => {
    return () => {
      staggerTimers.current.forEach(clearTimeout);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex items-center flex-nowrap whitespace-nowrap gap-0.5 text-body-2-medium">
        {/* First item — always visible */}
        <li className="inline-flex items-center min-w-0 shrink">
          {items[0].onClick ? (
            <button
              type="button"
              onClick={items[0].onClick}
              title={items[0].label}
              className="max-w-[100px] sm:max-w-[120px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary cursor-pointer bg-transparent border-0 font-medium"
            >
              {items[0].label}
            </button>
          ) : items[0].href ? (
            <a
              href={items[0].href}
              title={items[0].label}
              className="max-w-[100px] sm:max-w-[120px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary font-medium"
            >
              {items[0].label}
            </a>
          ) : (
            <span
              title={items[0].label}
              className="max-w-[100px] sm:max-w-[120px] truncate px-1 py-0.5 text-text-secondary font-medium"
            >
              {items[0].label}
            </span>
          )}
          {items.length > 1 && <Sep />}
        </li>

        {/* Expand / collapse trigger */}
        {shouldCollapse && (
          <li className="inline-flex items-center shrink-0">
            <button
              onClick={toggle}
              className="inline-flex size-6 items-center justify-center rounded-md text-text-secondary transition-colors duration-200 hover:bg-background-secondary-default hover:text-text-primary"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse path" : "Expand path"}
            >
              <span className="relative flex size-4 items-center justify-center">
                {/* Three dots — visible when collapsed */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="absolute inset-0"
                  style={{
                    opacity: expanded ? 0 : 1,
                    transform: expanded
                      ? "scale(0.8) rotate(-90deg)"
                      : "scale(1) rotate(0deg)",
                    transition: "all 0.2s cubic-bezier(0.0, 0.0, 0.2, 1)",
                  }}
                >
                  <circle cx="3" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="13" cy="8" r="1.2" />
                </svg>
                {/* Dash — visible when expanded */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="absolute inset-0"
                  style={{
                    opacity: expanded ? 1 : 0,
                    transform: expanded
                      ? "scale(1) rotate(0deg)"
                      : "scale(0.8) rotate(90deg)",
                    transition: "all 0.2s cubic-bezier(0.0, 0.0, 0.2, 1)",
                  }}
                >
                  <path
                    d="M4 8H12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </button>
            <Sep />
          </li>
        )}

        {/* Hidden items — unfold inline with stagger */}
        {expanded &&
          hiddenItems.map((item, i) => {
            const visible = itemVisible[i] ?? false;
            return (
              <li
                key={`hidden-${i}`}
                className="inline-flex items-center min-w-0 shrink"
                style={{
                  opacity: visible ? 1 : 0,
                  transform: visible ? "translateX(0)" : "translateX(-8px)",
                  transition:
                    "opacity 0.25s cubic-bezier(0.0, 0.0, 0.2, 1), transform 0.25s cubic-bezier(0.0, 0.0, 0.2, 1)",
                }}
              >
                {item.onClick ? (
                  <button
                    type="button"
                    onClick={item.onClick}
                    title={item.label}
                    className="max-w-[120px] sm:max-w-[150px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary cursor-pointer bg-transparent border-0 font-medium"
                  >
                    {item.label}
                  </button>
                ) : item.href ? (
                  <a
                    href={item.href}
                    title={item.label}
                    className="max-w-[120px] sm:max-w-[150px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary font-medium"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span
                    title={item.label}
                    className="max-w-[120px] sm:max-w-[150px] truncate px-1 py-0.5 text-text-secondary font-medium"
                  >
                    {item.label}
                  </span>
                )}
                <Sep />
              </li>
            );
          })}

        {/* Visible end items */}
        {visibleEnd.map((item, index) => {
          const isLast = index === visibleEnd.length - 1;
          return (
            <li key={`end-${index}`} className="inline-flex items-center min-w-0 shrink">
              {item.onClick && !isLast ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  title={item.label}
                  className="max-w-[120px] sm:max-w-[150px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary cursor-pointer bg-transparent border-0 font-medium"
                >
                  {item.label}
                </button>
              ) : item.href && !isLast ? (
                <a
                  href={item.href}
                  title={item.label}
                  className="max-w-[120px] sm:max-w-[150px] truncate rounded-md px-1 py-0.5 text-text-secondary transition-colors duration-200 hover:text-text-primary font-medium"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  title={item.label}
                  className={cn(
                    "max-w-[140px] sm:max-w-[180px] md:max-w-[220px] truncate px-1 py-0.5",
                    isLast
                      ? "font-semibold text-text-primary"
                      : "text-text-secondary font-medium",
                  )}
                  {...(isLast ? { "aria-current": "page" as const } : {})}
                >
                  {item.label}
                </span>
              )}
              {!isLast && <Sep />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Sep() {
  return (
    <span
      className="mx-0.5 select-none text-caption-2 text-text-tertiary"
      aria-hidden="true"
    >
      /
    </span>
  );
}

export { type BreadcrumbDropdownProps, type BreadcrumbDropdownItem };

import { HTMLAttributes, ReactNode } from "react";

/**
 * The floating surface primitive. Cards are white, hairline-edged, and lifted
 * off the page canvas by the `float` shadow — the elevation, not a heavy
 * border, is what separates them from the background.
 */

type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Adds the hover lift. Use for cards that are themselves links or buttons. */
  interactive?: boolean;
  /** Starts one step higher on the elevation scale (floating toolbars, popovers). */
  raised?: boolean;
};

export function Card({
  className = "",
  interactive = false,
  raised = false,
  ...props
}: CardProps) {
  return (
    <div
      className={[
        "rounded-card border border-slate-200/70 bg-white",
        raised ? "shadow-float-lg" : "shadow-float",
        interactive ? "hover-float cursor-pointer hover:border-slate-300/70" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 ${className}`}
      {...props}
    />
  );
}

export function CardTitle({ className = "", ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={`text-base font-semibold tracking-tight text-slate-900 ${className}`}
      {...props}
    />
  );
}

export function CardDescription({
  className = "",
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`text-sm leading-relaxed text-slate-500 ${className}`} {...props} />;
}

export function CardContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-5 ${className}`} {...props} />;
}

export function CardFooter({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3.5 ${className}`}
      {...props}
    />
  );
}

/**
 * Convenience wrapper for the overwhelmingly common shape: a titled card with
 * an optional action on the right and body content below. Saves repeating the
 * header/content scaffold in every page.
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={`overflow-hidden ${className}`}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="mt-0.5">{description}</CardDescription> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </CardHeader>
      <CardContent className={bodyClassName}>{children}</CardContent>
    </Card>
  );
}

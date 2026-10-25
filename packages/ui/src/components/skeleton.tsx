import { cn } from "cn"

// A placeholder shaped like the content that is loading (DESIGN.md §5.3, #1379). It pulses unless the reader asked for
// reduced motion, and says nothing to screen readers: the region around it carries aria-busy and the words.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...props} />
}

export { Skeleton }

import { cn } from "cn"
import { ClockIcon as LucideClockIcon } from "lucide-react"

// The time picker's button (#1432): 16px, stroke 1.5, currentColor, decorative (the button carries the name).
function ClockIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return <LucideClockIcon data-slot="clock-icon" aria-hidden="true" strokeWidth={1.5} className={cn("size-4", className)} {...props} />
}

export { ClockIcon }

import { cn } from "cn"
import { CalendarIcon as LucideCalendarIcon } from "lucide-react"

// The date picker's button (#1304): 16px, stroke 1.5, currentColor, decorative (the button carries the name).
function CalendarIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return <LucideCalendarIcon data-slot="calendar-icon" aria-hidden="true" strokeWidth={1.5} className={cn("size-4", className)} {...props} />
}

export { CalendarIcon }

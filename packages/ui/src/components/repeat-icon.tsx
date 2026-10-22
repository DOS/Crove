import { cn } from "cn"
import { Repeat2Icon } from "lucide-react"

// The recurring-post mark: 16px, stroke 1.5, currentColor, decorative (the caller gives the text).
function RepeatIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return <Repeat2Icon data-slot="repeat-icon" aria-hidden="true" strokeWidth={1.5} className={cn("inline size-4 align-text-bottom", className)} {...props} />
}

export { RepeatIcon }

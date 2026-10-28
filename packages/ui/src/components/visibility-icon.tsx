import { cn } from "cn"
import { LockIcon, UsersIcon } from "lucide-react"

// A note's lock (#1671, notes plan §3.10): a padlock for a private note, people for a shared one. 16px, stroke 1.5,
// currentColor, decorative: the word "Riêng tư" or "Dùng chung" beside it is the text.
function VisibilityIcon({ shared, className, ...props }: React.ComponentProps<"svg"> & { shared: boolean }) {
  const Icon = shared ? UsersIcon : LockIcon
  return <Icon data-slot="visibility-icon" aria-hidden="true" strokeWidth={1.5} className={cn("size-4", className)} {...props} />
}

export { VisibilityIcon }

import { cn } from "cn"
import { FileTextIcon } from "lucide-react"

// A document file (a PDF for a LinkedIn document post): 16px, stroke 1.5, currentColor, decorative (the caller gives the
// text).
function DocumentIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return <FileTextIcon data-slot="document-icon" aria-hidden="true" strokeWidth={1.5} className={cn("inline size-4 align-text-bottom", className)} {...props} />
}

export { DocumentIcon }

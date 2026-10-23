import { cn } from "cn"
import {
  BanknoteIcon,
  BellIcon,
  BellRingIcon,
  BookOpenCheckIcon,
  BoxesIcon,
  ChevronDownIcon,
  FileCheck2Icon,
  FileSpreadsheetIcon,
  FileTextIcon,
  InboxIcon,
  LandmarkIcon,
  ListChecksIcon,
  MegaphoneIcon,
  MenuIcon,
  NetworkIcon,
  NotebookPenIcon,
  SettingsIcon,
  TruckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

// The app shell's icons (DESIGN.md §3.7): 16px, stroke 1.5, currentColor, decorative (the label beside it is the text).
// One name per menu item or shell control, so the app never imports lucide-react itself.
const ICONS = {
  inbox: InboxIcon,
  alerts: BellIcon,
  tasks: ListChecksIcon,
  documents: FileTextIcon,
  journal: NotebookPenIcon,
  vouchers: BanknoteIcon,
  bank: LandmarkIcon,
  fixedAssets: BoxesIcon,
  ledger: BookOpenCheckIcon,
  vat: FileSpreadsheetIcon,
  portalList: FileCheck2Icon,
  customers: UsersIcon,
  vendors: TruckIcon,
  social: MegaphoneIcon,
  notifications: BellRingIcon,
  agents: NetworkIcon,
  settings: SettingsIcon,
  menu: MenuIcon,
  close: XIcon,
  expand: ChevronDownIcon,
} as const

type NavIconName = keyof typeof ICONS

function NavIcon({ name, className, ...props }: { name: NavIconName } & React.ComponentProps<"svg">) {
  const Icon = ICONS[name]
  return <Icon data-slot="nav-icon" aria-hidden="true" strokeWidth={1.5} className={cn("size-4 shrink-0", className)} {...props} />
}

export { NavIcon, type NavIconName }

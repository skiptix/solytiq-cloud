// Vendored from the shadcn CLI (`shadcn@4.16.2 view utils`), registry item
// "utils" — the standard `cn()` classname helper every shadcn-family
// component expects at `@/lib/utils`. Unmodified.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

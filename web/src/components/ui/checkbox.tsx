import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors outline-none focus-visible:ring-3",
        "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        "data-indeterminate:border-primary data-indeterminate:bg-primary/60 data-indeterminate:text-primary-foreground dark:data-indeterminate:bg-primary/60",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3.5 group-data-[indeterminate]/checkbox:hidden" />
        <MinusIcon className="hidden size-3.5 group-data-[indeterminate]/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }

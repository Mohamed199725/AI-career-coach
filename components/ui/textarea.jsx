import * as React from "react"

import { cn } from "@/lib/utils"

// Strip non-HTML props so they are never spread onto the element. A non-string
// `error` (e.g. an object) would otherwise land on the DOM as the literal text
// "[object Object]" in the field.
const Textarea = React.forwardRef(({ className, error, ...props }, ref) => {
  return (
    (<textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props} />)
  );
})
Textarea.displayName = "Textarea"

export { Textarea }

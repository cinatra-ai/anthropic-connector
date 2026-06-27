import * as React from "react"

import { cn } from "@cinatra-ai/sdk-ui/lib/utils"

// Thin native-element wrapper (mirrors the connector ecosystem's
// components/ui/input.tsx + textarea.tsx pattern): a server-action <form>
// submits the raw <select> by name with no client state. The raw <select>
// lives inside components/ui (exempt from the ui-design-system Block B
// raw-JSX ban), so call sites use <Select> and stay clean.
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "rounded-control border border-line bg-surface-strong px-4 py-3",
        className
      )}
      {...props}
    />
  )
}

export { Select }

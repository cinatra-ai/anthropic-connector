import * as React from "react"

import { cn } from "@cinatra-ai/sdk-ui/lib/utils"

// Thin native anchor wrapper for the shadcn link pattern
// (<Button asChild><Link/></Button>): the raw <a> lives inside
// components/ui (exempt from the ui-design-system Block B raw-JSX ban),
// so call sites use <Link> and stay clean while behavior is unchanged.
function Link({ className, ...props }: React.ComponentProps<"a">) {
  return <a data-slot="link" className={cn(className)} {...props} />
}

export { Link }

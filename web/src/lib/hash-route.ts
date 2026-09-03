import { useCallback, useEffect, useState } from "react"

function read(): string | null {
  const m = /^#\/item\/([A-Za-z0-9]+)/.exec(window.location.hash)
  return m ? m[1]! : null
}

export function useHashRoute(): {
  itemId: string | null
  navigate: (id: string | null) => void
} {
  const [itemId, setItemId] = useState<string | null>(read)
  useEffect(() => {
    const onChange = () => setItemId(read())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  const navigate = useCallback((id: string | null) => {
    const next = id ? `#/item/${id}` : "#/"
    if (window.location.hash !== next) window.location.hash = next
    else setItemId(id)
  }, [])
  return { itemId, navigate }
}

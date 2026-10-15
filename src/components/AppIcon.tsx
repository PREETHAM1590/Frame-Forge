import { useEffect, useState } from "react";
import { request } from "../api";

// Icons of running programs, fetched by image name (the main process holds the paths), a few at once, kept for the session.
const cache = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: Array<() => void> = [];
function pump() {
  while (running < 3 && waiting.length) {
    running++;
    waiting.shift()!();
  }
}
function load(image: string): Promise<string | null> {
  const key = image.toLowerCase();
  let hit = cache.get(key);
  if (!hit) {
    hit = new Promise<string | null>((resolve) => {
      waiting.push(() => {
        request("appIcon", { image })
          .catch(() => null)
          .then(resolve)
          .finally(() => {
            running--;
            pump();
          });
      });
      pump();
    });
    cache.set(key, hit);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
/** Forget icons after a new process list (paths may have changed). */
export const clearAppIcons = () => cache.clear();

export function AppIcon({
  image,
  name,
  desktop,
}: {
  image: string;
  name: string;
  desktop: boolean;
}) {
  const [loaded, setLoaded] = useState<{
    image: string;
    icon: string | null;
  }>();
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void load(image).then((icon) => active && setLoaded({ image, icon }));
    return () => {
      active = false;
    };
  }, [image, desktop]);
  const icon = loaded?.image === image ? loaded.icon : null;
  return icon ? (
    <img className="app-icon" src={icon} alt="" />
  ) : (
    <span className="app-icon placeholder" aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

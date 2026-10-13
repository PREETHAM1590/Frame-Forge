import { useEffect, useState } from "react";
import { request } from "../api";

// Icons are fetched one id at a time (the main process resolves the paths), a few at once,
// and kept for the session. A finished scan clears them so changed art is picked up.
const cache = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
const listeners = new Set<() => void>();
let running = 0;
const limit = 4;
const cacheSize = 200;

function next() {
  while (running < limit && waiting.length) {
    running++;
    waiting.shift()!();
  }
}
function load(id: string): Promise<string | null> {
  let hit = cache.get(id);
  if (hit) {
    // Least recently used goes first.
    cache.delete(id);
    cache.set(id, hit);
  } else {
    hit = new Promise<string | null>((resolve) => {
      waiting.push(() => {
        request("gameIcon", { id })
          .catch(() => null)
          .then(resolve)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
    cache.set(id, hit);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
export function clearGameIcons() {
  cache.clear();
  listeners.forEach((listener) => listener());
}

export function GameIcon({
  game,
  size = 40,
}: {
  game: { id: string; name: string };
  size?: number;
}) {
  // Tagged with its id so a changed game never shows the previous game's icon.
  const [loaded, setLoaded] = useState<{ id: string; icon: string | null }>();
  const icon = loaded?.id === game.id ? loaded.icon : null;
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const listener = () => setEpoch((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  useEffect(() => {
    let active = true;
    void load(game.id).then(
      (value) => active && setLoaded({ id: game.id, icon: value }),
    );
    return () => {
      active = false;
    };
  }, [game.id, epoch]);
  const style = { width: size, height: size };
  return icon ? (
    <img className="game-icon" src={icon} alt="" style={style} />
  ) : (
    <span
      className="game-icon placeholder"
      aria-hidden="true"
      style={{ ...style, fontSize: size * 0.45 }}
    >
      {Array.from(game.name.trim())[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

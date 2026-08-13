import type { Metadata } from "next";
import { StarfighterGame } from "./game/StarfighterGame";

export const metadata: Metadata = {
  title: "Rogue Vector — WebGL2 Starfighter Combat",
  description:
    "A performance-first arcade space dogfight. Fly an X-wing-inspired starfighter against TIE fighters, interceptors, and stealth bombers.",
};

export default function Home() {
  return <StarfighterGame />;
}
